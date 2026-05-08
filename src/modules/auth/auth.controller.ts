import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { createRequestLogger } from "../../middlewares/logger";
import { success, created } from "../../utils/response";
import { badRequest } from "../../utils/appError";

export const AuthController = {
  // ---------Merchant--------------

  async registerMerchant(req: Request, res: Response) {
    const log = createRequestLogger(req); // create logger for this request
    const { user, emailToken } = await AuthService.registerMerchant(req.body); // call register service
    log.info("Merchant registered successfully", { userId: user.id }); // log success
    created(
      res,
      { user, emailToken },
      "Account created. Check your email to verify",
    ); // send 201 response
  },

  async loginMerchant(req: Request, res: Response) {
    const { email, password, twoFactorCode } = req.body; // get login details from body
    if (!email || !password) {
      throw badRequest("Email and password are required"); // validate required fields
    }
    const result = await AuthService.loginMerchant(
      email,
      password,
      twoFactorCode,
    ); // call login service
    res.cookie("jwt", result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    }); // set access token cookie
    success(res, result, "Login successful"); // send success response
  },

  async verifyMerchantEmail(req: Request, res: Response): Promise<void> {
    const { token } = req.params; // get token from url param
    if (!token || Array.isArray(token)) {
      throw badRequest("Verification token is required"); // validate token
    }
    await AuthService.verifyMerchantEmail(token); // call verify service
    success(res, null, "Email verified successfully"); // send success
  },

  async resendEmailVerification(req: Request, res: Response): Promise<void> {
    const { email } = req.body; // get email from body
    if (!email) {
      throw badRequest("Email is required"); // validate email
    }
    const { emailToken } = await AuthService.resendEmailVerification(email); // call resend service
    success(res, { emailToken }, "Verification link sent"); // send success
  },

  async refreshMerchantToken(req: Request, res: Response) {
    const refreshToken = req.body.refreshToken || req.cookies.refreshToken; // get from body or cookie
    const refreshTokenFamily =
      req.body.refreshTokenFamily || req.cookies.refreshTokenFamily; // get family
    if (!refreshToken || !refreshTokenFamily) {
      throw badRequest("Refresh token and family are required"); // validate
    }
    const tokens = await AuthService.refreshMerchantToken(
      refreshToken,
      refreshTokenFamily,
    ); // call refresh service
    res.cookie("jwt", tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    }); // set new access token
    success(res, tokens, "Token refreshed"); // send response
  },

  async logoutMerchant(req: Request, res: Response) {
    const { refreshToken, refreshTokenFamily } = req.body; // get tokens from body
    if (!refreshToken || !refreshTokenFamily) {
      throw badRequest("Refresh token and family are required"); // validate
    }
    await AuthService.logoutMerchant(refreshToken, refreshTokenFamily); // call logout service
    res.clearCookie("jwt"); // clear access cookie
    res.clearCookie("refreshToken"); // clear refresh cookie
    success(res, null, "Logged out successfully"); // send success
  },

  async forgotMerchantPassword(req: Request, res: Response) {
    const { email } = req.body; // get email
    if (!email) {
      throw badRequest("Email is required"); // validate
    }
    await AuthService.forgotMerchantPassword(email); // call forgot service
    success(
      res,
      null,
      "If an account with this email exists, we will send you a link to reset your password",
    ); // send generic success
  },

  async resetMerchantPassword(req: Request, res: Response) {
    const token = req.query.token as string; // get token from query
    if (!token || typeof token !== "string") {
      throw badRequest("Please initiate the password reset process again"); // validate
    }
    const { newPassword } = req.body; // get new password
    if (!newPassword) {
      throw badRequest("Password is required"); // validate
    }
    const tokens = await AuthService.resetMerchantPassword(token, newPassword); // call reset service
    res.cookie("jwt", tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    }); // set new access token
    success(res, tokens, "Password reset successfully"); // send success
  },

  async updateMerchantPassword(req: Request, res: Response) {
    const userId = req.user?.id;
    if (typeof userId !== "string") {
      throw badRequest("User ID is required"); // validate
    }
    const { oldPassword, newPassword } = req.body; // get passwords
    if (!oldPassword || !newPassword) {
      throw badRequest("Both old and new passwords are required"); // validate
    }
    const tokens = await AuthService.updateMerchantPassword(
      userId,
      oldPassword,
      newPassword,
    ); // call update service
    res.cookie("jwt", tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
      maxAge: 15 * 60 * 1000,
    }); // set new access token cookie
    success(res, null, "Password updated successfully"); // send success
  },
};
