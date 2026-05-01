import "dotenv/config";
import express from "express";
import { prisma } from "./config/db.ts";
const app = express();

// ======================
// Global Middlewares
// ======================
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true }));

// ======================
// Health check route
// ======================

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
export default app;
