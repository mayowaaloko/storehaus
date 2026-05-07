import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { createRequestLogger } from "../../middlewares/logger";
import { success, created } from "../../utils/response";
import { badRequest } from "../../utils/appError";

export const AuthController = {
  //  ---------Merchant--------------

  async registerMerchant(req: Request, res: Response) {
    const log = createRequestLogger(req);
    const { user, emailToken } = await AuthService.registerMerchant(req.body);
    // enqueue email job
    log.info("Merchant registered successfully", { userId: user.id });
    created(
      res,
      { user, emailToken },
      "Account created. Check your email to verify",
    );
  },
  async loginMerchant(req: Request, res: Response) {
    // get the details from the boody
    const { email, password, twoFactorCode } = req.body;
    if (!email || !password) {
      throw badRequest("Email and password are required");
    }
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
    const { token } = req.params;
    // check the token exists
    if (!token || Array.isArray(token)) {
      throw badRequest("Verification token is required");
    }
    await AuthService.verifyMerchantEmail(token);
    success(res, null, "Email verified successfully");
  },
  async resendEmailVerification(req: Request, res: Response): Promise<void> {
    const { email } = req.body;
    if (!email) {
      throw badRequest("Email is required");
    }
    const { emailToken } = await AuthService.resendEmailVerification(email);
    success(res, { emailToken }, "Verification link sent");
  },
  async refreshMerchantToken(req: Request, res: Response) {
    const { refreshToken, refreshTokenFamily } =
      req.body || req.cookies.refreshToken;
    if (!refreshToken || !refreshTokenFamily) {
      throw badRequest("Refresh token and family are required");
    }
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
    if (!refreshToken || !refreshTokenFamily) {
      throw badRequest("Refresh token and family are required");
    }
    await AuthService.logoutMerchant(refreshToken, refreshTokenFamily);
    res.clearCookie("jwt");
    res.clearCookie("refreshToken");
    success(res, null, "Logged out successfully");
  },
  async forgotMerchantPassword(req: Request, res: Response) {
    const { email } = req.body;
    if (!email) {
      throw badRequest("Email is required");
    }
    const resetLink = await AuthService.forgotMerchantPassword(email);
    // email queue
    success(
      res,
      null,
      "If an account with that email exists, a reset link has been sent.",
    );
  },
};
