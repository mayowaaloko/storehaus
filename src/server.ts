// src/server.ts
import "dotenv/config";
import app from "./app.ts";
import { connectDB, disconnectDB } from "./config/db.ts";

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  let server: any; // to access server in shutdown

  try {
    // 1. Connect to Database first
    await connectDB();

    // 2. Start the Express server
    server = app.listen(PORT, () => {
      console.log(`🚀 Server is running on port ${PORT}`);
    });
  } catch (err: unknown) {
    console.error("❌ Failed to start server:", err);
    await disconnectDB();
    process.exit(1);
  }

  // ======================
  // Handle Uncaught Exceptions & Rejections
  // ======================
  process.on("uncaughtException", async (err) => {
    console.error("❌ Uncaught Exception:", err);
    await gracefulShutdown(server, "Uncaught Exception");
  });

  process.on("unhandledRejection", async (reason, promise) => {
    console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
    await gracefulShutdown(server, "Unhandled Rejection");
  });

  // ======================
  // Graceful Shutdown
  // ======================
  const gracefulShutdown = async (serverInstance: any, reason: string) => {
    console.log(`\n${reason} received. Shutting down gracefully...`);

    try {
      await disconnectDB(); // Close Prisma connection
      if (serverInstance) {
        serverInstance.close(() => {
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

    // Force exit after 10 seconds if something hangs
    setTimeout(() => {
      console.error("❌ Could not shut down gracefully. Forcing exit...");
      process.exit(1);
    }, 10000);
  };

  // Listen for termination signals
  process.on("SIGTERM", () => gracefulShutdown(server, "SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown(server, "SIGINT"));
};

// Start everything
startServer();
