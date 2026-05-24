import express from "express";
import { protect, restrictTo } from "../middlewares/auth";
import { validate } from "../validators/validate";
import {
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updatePasswordSchema,
} from "../modules/auth/auth.schema";
import { AuthController } from "../modules/auth/auth.controller";
import { authLimiter } from "../middlewares/rateLimiter";
import { catchAsync } from "../utils/catchAsync";
import { tenantMiddleware } from "../middlewares/tenants";

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMER AUTH (store-scoped, needs tenantMiddleware)
// ═══════════════════════════════════════════════════════════════════════════
// Mounted under /api/v1/stores/:slug so tenantMiddleware resolves req.store
const router = express.Router({ mergeParams: true });
router.route("/customer/register").post(
  authLimiter,
  tenantMiddleware, // resolves req.store from :slug
  validate(registerSchema),
  catchAsync(AuthController.registerCustomer),
);

router
  .route("/customer/verify-email/:token")
  .get(authLimiter, catchAsync(AuthController.verifyCustomerEmail));

router.route("/customer/login").post(
  authLimiter,
  tenantMiddleware, // resolves req.store from :slug
  validate(loginSchema),
  catchAsync(AuthController.loginCustomer),
);

router
  .route("/customer/resend-verification-email")
  .post(
    authLimiter,
    tenantMiddleware,
    catchAsync(AuthController.resendCustomerEmailVerification),
  );

router
  .route("/customer/refresh-token")
  .post(authLimiter, catchAsync(AuthController.refreshCustomerToken));

router
  .route("/customer/forgot-password")
  .post(
    authLimiter,
    tenantMiddleware,
    catchAsync(AuthController.forgotCustomerPassword),
  );

router
  .route("/customer/reset-password")
  .post(authLimiter, catchAsync(AuthController.resetCustomerPassword));

router
  .route("/customer/update-password")
  .patch(
    authLimiter,
    protect,
    validate(updatePasswordSchema),
    catchAsync(AuthController.updateCustomerPassword),
  );

export default router;
