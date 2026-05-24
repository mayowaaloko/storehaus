import express from "express";
import { protect, requireStoreOwner, restrictTo } from "../middlewares/auth";
import { validate } from "../validators/validate";
import {
  createStoreSchema,
  updateStoreSchema,
} from "../modules/stores/stores.schma";
import { catchAsync } from "../utils/catchAsync";
import { StoreController } from "../modules/stores/stores.controller";
import { tenantMiddleware } from "../middlewares/tenants";

import categoryRouter from "./categories.routes.ts"; // ← same routes/ folder
// import productRouter from "./products.routes.ts";       // ← same routes/ folder
// import orderRouter from "./orders.routes.ts";

const router = express.Router();

// Create a new store — merchant must be logged in
router
  .route("/")
  .post(
    protect,
    validate(createStoreSchema),
    catchAsync(StoreController.create),
  );

// List merchants own stores
router.route("/").get(protect, catchAsync(StoreController.list));

// Get one store by slug - public, no auth required
router
  .route("/:slug")
  .get(tenantMiddleware, catchAsync(StoreController.getOne));

// Update store - owner only
router
  .route("/:slug")
  .patch(
    protect,
    tenantMiddleware,
    requireStoreOwner,
    validate(updateStoreSchema),
    catchAsync(StoreController.update),
  );

// deactivate store-m-owner only
router
  .route("/:slug/deactivate")
  .delete(
    protect,
    tenantMiddleware,
    requireStoreOwner,
    catchAsync(StoreController.deactivate),
  );

// nested routers — mounted under /:slug
router.use("/:slug/categories", tenantMiddleware, categoryRouter);
// router.use("/:slug/products", tenantMiddleware, productRouter);
// router.use("/:slug/orders", tenantMiddleware, orderRouter);

export default router;
