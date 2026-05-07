import express from "express";
import { prisma } from "./config/db.ts";
import { globalErrorHandler } from "./middlewares/errorHandler.ts";
import { generalLimiter } from "./middlewares/rateLimiter.ts";
import auth from "./routes/auth.routes.ts";
const app = express();

// ======================
// Global Middlewares
// ======================
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true }));

// ======================
// Health check route
// ======================
app.use(generalLimiter);
app.get("/health", async (req, res) => {
  try {
    // Simple DB health check
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: "OK",
      database: "Connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      database: "Disconnected",
    });
  }
});
app.use("/api/v1/auth", auth);
app.use(globalErrorHandler);
export default app;
