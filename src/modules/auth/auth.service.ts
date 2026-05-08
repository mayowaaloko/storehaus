import crypto from "crypto";
import { prisma } from "../../config/db";
import {
  AppError,
  badRequest,
  locked,
  notFound,
  serverError,
  unauthorized,
} from "../../utils/appError";
import {
  generateAccessToken,
  generateRefreshToken,
  generateTemporaryToken,
  generateResetToken,
} from "../../utils/jwt";
import { verify } from "otplib";
import { logger } from "../../middlewares/logger";
import { comparePassword, hashPassword } from "../../utils/password";
import { cache } from "../../config/redis";

// ─── Constants ───
const MAX_FAILED_ATTEMPTS = 5; // lock account after 5 wrong passwords
const LOCK_DURATION_MINUTES = 30; // locked for 30 minutes
const RESET_TOKEN_EXPIRES_MINUTES = 10; // reset token expiry

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenFamily: string;
}

interface MerchantRegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phoneNumber?: string;
}

export const AuthService = {
  // REGISTER MERCHANT
  async registerMerchant(input: MerchantRegisterInput) {
    const { email, password, firstName, lastName, phoneNumber } = input; // destructure input

    const normalizedEmail = input.email.toLowerCase(); // normalize email to lowercase

    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    }); // check if user exists
    if (existingUser) {
      throw notFound("User with this email already exists"); // throw if duplicate
    }

    const hashedPassword = await hashPassword(password); // hash the password

    const { emailToken, hashedToken, expiresAt } =
      await generateTemporaryToken(); // generate verification token

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        password: hashedPassword,
        firstName,
        lastName,
        phoneNumber,
        emailVerificationToken: hashedToken,
        emailVerificationTokenExpiresAt: expiresAt,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isEmailVerified: true,
        role: true,
        createdAt: true,
      },
    }); // create user in db

    logger.info("Merchant registered", { userId: user.id, email: user.email }); // log registration
    return { user, emailToken }; // return user and plain token
  },

  async loginMerchant(
    email: string,
    password: string,
    twoFactorCode: string | undefined,
  ): Promise<AuthTokens & { user: object }> {
    const user = await prisma.user.findUnique({
      where: { email },
    }); // find user by email
    if (!user) {
      throw unauthorized("Invalid credentials"); // invalid email
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minuteLeft = Math.ceil(
        (user.lockedUntil.getTime() - new Date().getTime()) / (1000 * 60),
      ); // calculate remaining lock time
      logger.info("Account is locked", { userId: user.id, minuteLeft });
      throw locked(`Account is locked. Try again in ${minuteLeft} minutes`);
    }

    if (!user.isActive) {
      logger.info("Account is inactive", { userId: user.id });
      throw notFound("Your account has been deactivated. Contact support.");
    }

    const passwordValid = await comparePassword(password, user.password); // check password
    if (!passwordValid) {
      const newFailedAttempts = user.failedLoginAttempts + 1;
      const shouldLock = newFailedAttempts >= MAX_FAILED_ATTEMPTS;

      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: newFailedAttempts,
          lockedUntil: shouldLock
            ? new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000)
            : null,
        },
      }); // update failed attempts

      if (shouldLock) {
        logger.warn("Merchant account locked after failed attempts", { email });
        throw locked("Account locked due to multiple failed attempts");
      }
      throw unauthorized("Invalid credentials"); // wrong password
    }

    if (user.twofactorEnabled) {
      if (!user.twofactorSecret || !twoFactorCode) {
        throw serverError(
          "Two-factor authentication is enabled but not configured. Please contact support",
        );
      }
      const result = await verify({
        secret: user.twofactorSecret as string,
        token: twoFactorCode as string,
      }); // verify 2fa code
      if (!result.valid) {
        logger.warn("Invalid 2FA code", { email });
        throw unauthorized("Your 2FA code is invalid");
      }
    }

    if (user.failedLoginAttempts > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      }); // reset failed attempts
    }

    const accessToken = generateAccessToken(user); // generate access token
    const { token, family } = await generateRefreshToken(user.id, "user"); // generate refresh token

    logger.info("Merchant logged in", { userId: user.id, email }); // log login
    return {
      accessToken,
      refreshToken: token,
      refreshTokenFamily: family,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        twofactorEnabled: user.twofactorEnabled,
      },
    };
  },

  async verifyMerchantEmail(token: string) {
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex"); // hash token

    const user = await prisma.user.findFirst({
      where: {
        emailVerificationToken: hashedToken,
        emailVerificationTokenExpiresAt: { gt: new Date() },
        isEmailVerified: false,
      },
    }); // find user with valid token
    if (!user) {
      throw notFound("Invalid or expired verification link");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isEmailVerified: true,
        emailVerificationToken: null,
        emailVerificationTokenExpiresAt: null,
      },
    }); // mark as verified
    logger.info("Merchant email verified", {
      userId: user.id,
      email: user.email,
    });
  },

  async resendEmailVerification(email: string) {
    const user = await prisma.user.findUnique({
      where: { email },
    }); // find user
    if (!user) {
      throw notFound("User not found");
    }
    if (user.isEmailVerified) {
      throw badRequest("Your email is already verified.Please log in");
    }

    const { emailToken, hashedToken, expiresAt } =
      await generateTemporaryToken(); // new token

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationToken: hashedToken,
        emailVerificationTokenExpiresAt: expiresAt,
      },
    }); // update token in db

    return { emailToken }; // return plain token
  },

  async refreshMerchantToken(
    refreshToken: string,
    refreshTokenFamily: string,
  ): Promise<AuthTokens> {
    const hashedToken = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex"); // hash incoming token

    const storedToken = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashedToken },
    }); // find stored token

    if (!storedToken) {
      throw unauthorized("Invalid or expired refresh token");
    }

    if (storedToken.family !== refreshTokenFamily) {
      throw unauthorized("Invalid refresh token family");
    }

    if (storedToken.expiresAt < new Date()) {
      throw unauthorized("Refresh token expired");
    }

    if (storedToken.used || storedToken.revoked) {
      logger.warn("Refresh token reuse detected — revoking token family", {
        family: storedToken.family,
        userId: storedToken.userId,
      });

      await prisma.refreshToken.updateMany({
        where: { family: storedToken.family },
        data: { revoked: true },
      }); // revoke family

      throw unauthorized("Refresh token reuse detected");
    }

    await prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { used: true },
    }); // mark as used

    const user = await prisma.user.findUnique({
      where: { id: storedToken.userId! },
    }); // get user

    if (!user) {
      throw unauthorized("User not found");
    }

    const accessToken = generateAccessToken(user); // new access
    const { token: newRefreshToken, family } = await generateRefreshToken(
      user.id,
      "user",
      undefined,
      storedToken.family,
    ); // rotate refresh token

    logger.info("Merchant access token refreshed", {
      userId: user.id,
      family,
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      refreshTokenFamily: family,
    };
  },

  async logoutMerchant(
    refreshToken: string,
    refreshTokenFamily: string,
  ): Promise<void> {
    const hashedToken = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex"); // hash token

    const storedToken = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashedToken },
    }); // find token
    if (!storedToken) return;

    await prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revoked: true },
    }); // revoke token

    await cache.set(`token:revoked:${storedToken.userId}`, true, 15 * 60); // blocklist
    await cache.set(
      `token:family:${storedToken.userId}`,
      storedToken.family,
      15 * 60,
    );

    logger.info("Merchant logged out and token blocked", {
      family: refreshTokenFamily,
      userId: storedToken.userId,
    });
  },

  async forgotMerchantPassword(email: string): Promise<string | null> {
    const user = await prisma.user.findUnique({ where: { email } }); // find user
    if (!user) return null;

    const { hashedResetToken, resetToken, resetTokenExpiresAt } =
      await generateResetToken(); // generate reset token

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: hashedResetToken,
        resetTokenExpiresAt: resetTokenExpiresAt,
      },
    }); // save hashed token

    logger.info("Password reset token generated for user", {
      userId: user.id,
      email,
    });
    return resetToken; // return plain token for email
  },

  async resetMerchantPassword(token: string, newPassword: string) {
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex"); // hash token

    const user = await prisma.user.findFirst({
      where: {
        resetToken: hashedToken,
        resetTokenExpiresAt: { gt: new Date() },
      },
    }); // find valid token
    if (!user) {
      throw notFound("Invalid or expired reset link");
    }

    const hashedPassword = await hashPassword(newPassword); // hash new password

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiresAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    }); // update password

    await prisma.refreshToken.updateMany({
      where: { userId: user.id },
      data: { revoked: true },
    }); // revoke all sessions

    logger.info("Merchant password reset", {
      userId: user.id,
      email: user.email,
    });

    const accessToken = generateAccessToken(user); // new login tokens
    const { token: refreshToken, family } = await generateRefreshToken(
      user.id,
      "user",
    );

    return { accessToken, refreshToken, refreshTokenFamily: family };
  },

  async updateMerchantPassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    refreshTokenFamily: string;
  }> {
    const user = await prisma.user.findUnique({ where: { id: userId } }); // find user
    if (!user) {
      throw notFound("User not found");
    }

    const isOldPasswordValid = await comparePassword(
      oldPassword,
      user.password,
    ); // verify old password
    if (!isOldPasswordValid) {
      throw unauthorized("Current password is incorrect");
    }

    const hashedPassword = await hashPassword(newPassword); // hash new password

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    }); // update password

    await prisma.refreshToken.updateMany({
      where: { userId: user.id },
      data: { revoked: true },
    }); // revoke old sessions

    logger.info("Merchant password updated", { userId: user.id });

    const newToken = generateAccessToken(user); // new tokens
    const { token, family } = await generateRefreshToken(user.id, "user");

    return {
      accessToken: newToken,
      refreshToken: token,
      refreshTokenFamily: family,
    };
  },
};
