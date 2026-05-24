import express from "express";
import { prisma } from "./config/db.ts";
import { globalErrorHandler } from "./middlewares/errorHandler.ts";
import { generalLimiter } from "./middlewares/rateLimiter.ts";
import merchantAuthRoutes from "./routes/auth.merchant.routes";
import customerAuthRoutes from "./routes/auth.customer.routes";
import storeRoutes from "./routes/store.routes.ts";
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
// Merchant auth — no store context
app.use("/api/v1/auth", merchantAuthRoutes);
// Customer auth — needs :slug for tenantMiddleware
app.use("/api/v1/stores/:slug/auth", customerAuthRoutes);
app.use("/api/v1/stores", storeRoutes);
app.use(globalErrorHandler);
export default app;
