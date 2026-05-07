// src/server.ts
import "dotenv/config";
import { connectDB, disconnectDB } from "./config/db.ts";
import { connectRedis, disconnectRedis } from "./config/redis.ts";
import type { Server } from "http";

const PORT = process.env.APP_PORT || 5000;

// ─── Graceful shutdown ────────────────────────────────────────────────────────

const gracefulShutdown = async (server: Server | null, reason: string) => {
  console.log(`\n${reason} received. Shutting down gracefully...`);

  const forceExitTimer = setTimeout(() => {
    console.error("❌ Could not shut down gracefully. Forcing exit...");
    process.exit(1);
  }, 10_000);

  // Prevent the timer from blocking the event loop
  forceExitTimer.unref();

  try {
    await disconnectRedis();
    await disconnectDB();

    if (server) {
      server.close(() => {
        console.log("✅ HTTP server closed.");
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error("❌ Error during shutdown:", err);
    process.exit(1);
  }
};

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const startServer = async () => {
  let server: Server | null = null;

  process.on("uncaughtException", async (err) => {
    console.error("❌ Uncaught Exception:", err);
    await gracefulShutdown(server, "Uncaught Exception");
  });

  process.on("unhandledRejection", async (reason) => {
    console.error("❌ Unhandled Rejection:", reason);
    await gracefulShutdown(server, "Unhandled Rejection");
  });

  process.on("SIGTERM", () => gracefulShutdown(server, "SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown(server, "SIGINT"));

  try {
    // 1. Database
    await connectDB();

    // 2. Redis — must connect before app.ts is imported
    //    because rateLimiter.ts creates RedisStore on module load
    await connectRedis();

    // 3. Dynamically import app AFTER Redis is open
    console.log("⏳ Loading application...");
    const { default: app } = await import("./app.ts");
    console.log("✅ Application loaded");

    // 4. Start listening
    server = app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📋 Health check: http://localhost:${PORT}/health`);
    });

    // Catch listen-level errors (e.g. port already in use)
    server.on("error", async (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`❌ Port ${PORT} is already in use`);
      } else {
        console.error("❌ Server error:", err);
      }
      await gracefulShutdown(server, "Server Error");
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    await disconnectRedis();
    await disconnectDB();
    process.exit(1);
  }
};

startServer();
