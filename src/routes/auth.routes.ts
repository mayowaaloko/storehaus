import express from "express";
import { protect, restrictTo } from "../middlewares/auth";
import { validate } from "../validators/validate";
import { registerSchema } from "../modules/auth/auth.schema";
import { AuthController } from "../modules/auth/auth.controller";
import { authLimiter } from "../middlewares/rateLimiter";
const router = express.Router();

// Merchant auth

router
  .route("/merchant/register")
  .post(authLimiter, validate(registerSchema), AuthController.registerMerchant);
router.route("/merchant/login").post(authLimiter, AuthController.loginMerchant);
export default router;
