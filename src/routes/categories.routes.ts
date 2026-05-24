// All category routes live under /api/v1/stores/:slug/categories
// They are mounted on the stores router — so tenantMiddleware
// has already run and req.store is populated before any of these fire.
//
//   GET    /api/v1/stores/:slug/categories            → public
//   POST   /api/v1/stores/:slug/categories            → merchant only
//   PUT    /api/v1/stores/:slug/categories/:categoryId → merchant only
//   DELETE /api/v1/stores/:slug/categories/:categoryId → merchant only

import express from "express";
import { categoryController } from "../modules/categories/categories.controller";
import { protect, requireStoreOwner } from "../middlewares/auth";
import { catchAsync } from "../utils/catchAsync";
import { validate } from "../validators/validate";
import {
  createCategorySchema,
  updateCategorySchema,
} from "../modules/categories/categories.schema";

const router = express.Router({ mergeParams: true });

// Public — anyone can see a store's categories
router.route("/").get(catchAsync(categoryController.list));

// merchant only-must own the store
router
  .route("/")
  .post(
    protect,
    requireStoreOwner,
    validate(createCategorySchema),
    catchAsync(categoryController.create),
  );

router
  .route("/:categoryId")
  .put(
    protect,
    requireStoreOwner,
    validate(updateCategorySchema),
    catchAsync(categoryController.update),
  );

router
  .route("/:categoryId")
  .delete(protect, requireStoreOwner, catchAsync(categoryController.delete));
export default router;
