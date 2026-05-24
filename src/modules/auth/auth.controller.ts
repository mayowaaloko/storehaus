// Unified auth controller exposing endpoints for both merchants and customers.
// Customer endpoints are scoped to a store (req.store!) because a customer
// account only exists within one store.

import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { createRequestLogger } from "../../middlewares/logger";
import { success, created } from "../../utils/response";
import { badRequest } from "../../utils/appError";

function getParamToken(req: Request): string {
  const { token } = req.params;
  if (!token || Array.isArray(token)) throw badRequest("Token is required");
  return token;
}

export const AuthController = {
  // ═══════════════════════════════════════════════════════════════════════════
  // MERCHANT ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════════

  async registerMerchant(req: Request, res: Response) {
    const log = createRequestLogger(req);
    const { user, emailToken } = await AuthService.registerMerchant(req.body);
    log.info("Merchant registered successfully", { userId: user.id });
    created(
      res,
      { user, emailToken },
      "Account created. Check your email to verify",
    );
  },

  async loginMerchant(req: Request, res: Response) {
    const { email, password, twoFactorCode } = req.body;
    if (!email || !password)
      throw badRequest("Email and password are required");

    const result = await AuthService.loginMerchant(
      email,
      password,
      twoFactorCode,
    );

    res.cookie("jwt", result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    });
    success(res, result, "Login successful");
  },

  async verifyMerchantEmail(req: Request, res: Response): Promise<void> {
    const token = getParamToken(req);
    await AuthService.verifyMerchantEmail(token);
    success(res, null, "Email verified successfully");
  },

  async resendMerchantEmailVerification(
    req: Request,
    res: Response,
  ): Promise<void> {
    const { email } = req.body;
    if (!email) throw badRequest("Email is required");
    const { emailToken } =
      await AuthService.resendMerchantEmailVerification(email);
    success(res, { emailToken }, "Verification link sent");
  },

  async refreshMerchantToken(req: Request, res: Response) {
    const refreshToken = req.body.refreshToken || req.cookies.refreshToken;
    const refreshTokenFamily =
      req.body.refreshTokenFamily || req.cookies.refreshTokenFamily;
    if (!refreshToken || !refreshTokenFamily)
      throw badRequest("Refresh token and family are required");

    const tokens = await AuthService.refreshMerchantToken(
      refreshToken,
      refreshTokenFamily,
    );

    res.cookie("jwt", tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    });
    success(res, tokens, "Token refreshed");
  },

  async logoutMerchant(req: Request, res: Response) {
    const { refreshToken, refreshTokenFamily } = req.body;
    if (!refreshToken || !refreshTokenFamily)
      throw badRequest("Refresh token and family are required");

    await AuthService.logoutMerchant(refreshToken, refreshTokenFamily);
    res.clearCookie("jwt");
    res.clearCookie("refreshToken");
    success(res, null, "Logged out successfully");
  },

  async forgotMerchantPassword(req: Request, res: Response) {
    const { email } = req.body;
    if (!email) throw badRequest("Email is required");
    await AuthService.forgotMerchantPassword(email);
    success(
      res,
      null,
      "If an account with this email exists, we will send you a link to reset your password",
    );
  },

  async resetMerchantPassword(req: Request, res: Response) {
    const token = req.query.token as string;
    if (!token || typeof token !== "string")
      throw badRequest("Please initiate the password reset process again");

    const { newPassword } = req.body;
    if (!newPassword) throw badRequest("Password is required");

    const tokens = await AuthService.resetMerchantPassword(token, newPassword);
    res.cookie("jwt", tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    });
    success(res, tokens, "Password reset successfully");
  },

  async updateMerchantPassword(req: Request, res: Response) {
    const userId = req.user?.id;
    if (typeof userId !== "string") throw badRequest("User ID is required");

    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword)
      throw badRequest("Both old and new passwords are required");

    const tokens = await AuthService.updateMerchantPassword(
      userId,
      oldPassword,
      newPassword,
    );
    res.cookie("jwt", tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    });
    success(res, null, "Password updated successfully");
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOMER ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════════
  // All customer endpoints need the store context (tenantMiddleware must run
  // before these so that req.store is populated).

  async registerCustomer(req: Request, res: Response) {
    const log = createRequestLogger(req);
    const storeId = req.store?.id;
    if (!storeId) throw badRequest("Store context is required");

    const { customer, emailToken } = await AuthService.registerCustomer({
      ...req.body,
      storeId,
    });

    log.info("Customer registered successfully", {
      customerId: customer.id,
      storeId,
    });
    created(
      res,
      { customer, emailToken },
      "Account created. Check your email to verify",
    );
  },

  async loginCustomer(req: Request, res: Response) {
    const storeId = req.store?.id;
    if (!storeId) throw badRequest("Store context is required");

    const { email, password } = req.body;
    if (!email || !password)
      throw badRequest("Email and password are required");

    const result = await AuthService.loginCustomer(email, password, storeId);

    res.cookie("jwt", result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    });
    success(res, result, "Login successful");
  },

  async verifyCustomerEmail(req: Request, res: Response): Promise<void> {
    const token = getParamToken(req);
    await AuthService.verifyCustomerEmail(token);
    success(res, null, "Email verified successfully");
  },

  async resendCustomerEmailVerification(
    req: Request,
    res: Response,
  ): Promise<void> {
    const storeId = req.store?.id;
    if (!storeId) throw badRequest("Store context is required");

    const { email } = req.body;
    if (!email) throw badRequest("Email is required");

    const { emailToken } = await AuthService.resendCustomerEmailVerification(
      email,
      storeId,
    );
    success(res, { emailToken }, "Verification link sent");
  },

  async refreshCustomerToken(req: Request, res: Response) {
    const refreshToken = req.body.refreshToken || req.cookies.refreshToken;
    const refreshTokenFamily =
      req.body.refreshTokenFamily || req.cookies.refreshTokenFamily;
    if (!refreshToken || !refreshTokenFamily)
      throw badRequest("Refresh token and family are required");

    const tokens = await AuthService.refreshCustomerToken(
      refreshToken,
      refreshTokenFamily,
    );

    res.cookie("jwt", tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    });
    success(res, tokens, "Token refreshed");
  },

  async logoutCustomer(req: Request, res: Response) {
    const { refreshToken, refreshTokenFamily } = req.body;
    if (!refreshToken || !refreshTokenFamily)
      throw badRequest("Refresh token and family are required");

    await AuthService.logoutCustomer(refreshToken, refreshTokenFamily);
    res.clearCookie("jwt");
    res.clearCookie("refreshToken");
    success(res, null, "Logged out successfully");
  },

  async forgotCustomerPassword(req: Request, res: Response) {
    const storeId = req.store?.id;
    if (!storeId) throw badRequest("Store context is required");

    const { email } = req.body;
    if (!email) throw badRequest("Email is required");

    await AuthService.forgotCustomerPassword(email, storeId);
    success(
      res,
      null,
      "If an account with this email exists in this store, we will send you a link",
    );
  },

  async resetCustomerPassword(req: Request, res: Response) {
    const token = req.query.token as string;
    if (!token || typeof token !== "string")
      throw badRequest("Please initiate the password reset process again");

    const { newPassword } = req.body;
    if (!newPassword) throw badRequest("Password is required");

    const tokens = await AuthService.resetCustomerPassword(token, newPassword);
    res.cookie("jwt", tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    });
    success(res, tokens, "Password reset successfully");
  },

  async updateCustomerPassword(req: Request, res: Response) {
    const customerId = req.user?.id;
    if (typeof customerId !== "string")
      throw badRequest("Customer ID is required");

    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword)
      throw badRequest("Both old and new passwords are required");

    const tokens = await AuthService.updateCustomerPassword(
      customerId,
      oldPassword,
      newPassword,
    );
    res.cookie("jwt", tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    });
    success(res, null, "Password updated successfully");
  },
};
