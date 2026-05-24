// Auth routes — split into merchant (platform-level) and customer (store-scoped).
// Customer routes need tenantMiddleware so req.store is populated.

import express from "express";
import { protect, restrictTo } from "../middlewares/auth";
import { validate } from "../validators/validate";
import {
  loginSchema,
  registerSchema,
  updatePasswordSchema,
} from "../modules/auth/auth.schema";
import { AuthController } from "../modules/auth/auth.controller";
import { authLimiter } from "../middlewares/rateLimiter";
import { catchAsync } from "../utils/catchAsync";
const router = express.Router({ mergeParams: true });

// ═══════════════════════════════════════════════════════════════════════════
// MERCHANT AUTH (platform-level, no store context needed)
// ═══════════════════════════════════════════════════════════════════════════

router
  .route("/merchant/register")
  .post(
    authLimiter,
    validate(registerSchema),
    catchAsync(AuthController.registerMerchant),
  );

router
  .route("/merchant/verify-email/:token")
  .get(authLimiter, catchAsync(AuthController.verifyMerchantEmail));

router
  .route("/merchant/login")
  .post(
    authLimiter,
    validate(loginSchema),
    catchAsync(AuthController.loginMerchant),
  );

router
  .route("/merchant/resend-verification-email")
  .post(
    authLimiter,
    catchAsync(AuthController.resendMerchantEmailVerification),
  );

router
  .route("/merchant/refresh-token")
  .post(authLimiter, catchAsync(AuthController.refreshMerchantToken));

router
  .route("/merchant/forgot-password")
  .post(authLimiter, catchAsync(AuthController.forgotMerchantPassword));

router
  .route("/merchant/reset-password")
  .post(authLimiter, catchAsync(AuthController.resetMerchantPassword));

router
  .route("/merchant/update-password")
  .patch(
    authLimiter,
    protect,
    restrictTo("MERCHANT"),
    validate(updatePasswordSchema),
    catchAsync(AuthController.updateMerchantPassword),
  );

export default router;
