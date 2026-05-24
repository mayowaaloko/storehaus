//   POST   /api/v1/stores/:slug/orders                 → customer only
//   GET    /api/v1/stores/:slug/orders                 → merchant (all) / customer (own)
//   GET    /api/v1/stores/:slug/orders/:orderId        → merchant / owning customer
//   PATCH  /api/v1/stores/:slug/orders/:orderId/status → merchant only
//   POST   /api/v1/stores/:slug/orders/:orderId/cancel → customer only (PENDING only)

import { Router } from "express";
import { OrderController } from "../modules/orders/orders.controller";
import {
  protect,
  restrictTo,
  requireStoreOwner,
  requireCustomer,
} from "../middlewares/auth";
import { validate } from "../validators/validate";
import { catchAsync } from "../utils/catchAsync";
import {
  createOrderSchema,
  updateOrderStatusSchema,
} from "../modules/orders/orders.schema";

const router = Router({ mergeParams: true });

// Place order — customer must be logged in
// Idempotency-Key header recommended — checked in controller
router.post(
  "/",
  protect,
  requireCustomer,
  validate(createOrderSchema),
  catchAsync(OrderController.create),
);

// List orders
// protect runs first — then the service filters by role
router.get("/", protect, catchAsync(OrderController.list));

// Get single order
router.get("/:orderId", protect, catchAsync(OrderController.getOne));

// Update order status — merchant only
router.patch(
  "/:orderId/status",
  protect,
  requireStoreOwner,
  validate(updateOrderStatusSchema),
  catchAsync(OrderController.updateStatus),
);

// Cancel order — customer only, PENDING orders only
// restrictTo blocks merchants from using this endpoint — they use /status instead
router.post(
  "/:orderId/cancel",
  protect,
  requireCustomer,
  catchAsync(OrderController.cancel),
);

export default router;
