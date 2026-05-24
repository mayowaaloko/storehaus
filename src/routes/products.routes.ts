//   GET    /api/v1/stores/:slug/products              → public (published only)
//   POST   /api/v1/stores/:slug/products              → merchant only
//   GET    /api/v1/stores/:slug/products/:productId   → public (published only)
//   PUT    /api/v1/stores/:slug/products/:productId   → merchant only
//   PATCH  /api/v1/stores/:slug/products/:productId/publish → merchant only
//   DELETE /api/v1/stores/:slug/products/:productId   → merchant only

import { Router } from "express";
import { ProductController } from "../modules/products/products.controller";
import { protect, requireStoreOwner } from "../middlewares/auth";
import { validate } from "../validators/validate";
import { catchAsync } from "../utils/catchAsync";
import {
  createProductSchema,
  updateProductSchema,
} from "../modules/products/products.schema";

const router = Router({ mergeParams: true });

// ── Public routes ─────────────────────────────────────────────────────────────

router.get("/", catchAsync(ProductController.list));
router.get("/:productId", catchAsync(ProductController.getOne));

// ── Merchant only ─────────────────────────────────────────────────────────────

router.post(
  "/",
  protect,
  requireStoreOwner,
  validate(createProductSchema),
  catchAsync(ProductController.create),
);

router.put(
  "/:productId",
  protect,
  requireStoreOwner,
  validate(updateProductSchema),
  catchAsync(ProductController.update),
);

router.patch(
  "/:productId/publish",
  protect,
  requireStoreOwner,
  catchAsync(ProductController.togglePublish),
);

router.delete(
  "/:productId",
  protect,
  requireStoreOwner,
  catchAsync(ProductController.delete),
);

export default router;
