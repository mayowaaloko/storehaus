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
import { verify, generateURI, generateSecret, generate } from "otplib";
import { logger } from "../../middlewares/logger";
import { comparePassword, hashPassword } from "../../utils/password";
import { cache } from "../../config/redis";
// ─── Constants ───
const MAX_FAILED_ATTEMPTS = 5; // lock account after 5 wrong passwords
const LOCK_DURATION_MINUTES = 30; // locked for 30 minutes
const RESET_TOKEN_EXPIRES_MINUTES = 60;
const VERIFY_TOKEN_EXPIRES_HOURS = 24;

// TYPES

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

interface CustomerRegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phoneNumber?: string;
  storeId: string;
}
export const AuthService = {
  // REGISTER MERCHANT
  async registerMerchant(input: MerchantRegisterInput) {
    const { email, password, firstName, lastName, phoneNumber } = input;

    // normalize the email
    const normalizedEmail = input.email.toLowerCase();

    // check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: {
        email: normalizedEmail,
      },
    });
    if (existingUser) {
      throw notFound("User with this email already exists");
    }
    // hash password
    const hashedPassword = await hashPassword(password);

    // email verification
    const { emailToken, hashedToken, expiresAt } =
      await generateTemporaryToken();

    // create a new user
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
    });
    logger.info("Merchant registered", { userId: user.id, email: user.email });
    return { user, emailToken };
  },

  async loginMerchant(
    email: string,
    password: string,
    twoFactorCode: string | undefined,
  ): Promise<AuthTokens & { user: object }> {
    // find user by email
    const user = await prisma.user.findUnique({
      where: { email },
    });
    if (!user) {
      throw unauthorized("Invalid credentials");
    }
    // check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minuteLeft = Math.ceil(
        (user.lockedUntil.getTime() - new Date().getTime()) / (1000 * 60),
      );
      logger.info("Account is locked", { userId: user.id, minuteLeft });
      throw locked(`Account is locked. Try again in ${minuteLeft} minutes`);
    }
    // check if account is active
    if (!user.isActive) {
      logger.info("Account is inactive", { userId: user.id });
      throw notFound("Your account has been deactivated. Contact support.");
    }
    // check if password is correct
    const passwordValid = await comparePassword(password, user.password);
    if (!passwordValid) {
      // increment failed attempts
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
      });

      if (shouldLock) {
        logger.warn("Merchant account locked after failed attempts", { email });
        throw locked("Account locked due to multiple failed attempts");
      }
    }
    // 2FA check
    if (user.twofactorEnabled) {
      if (!user.twofactorSecret || !twoFactorCode) {
        throw serverError(
          "Two-factor authentication is enabled but not configured. Please contact support",
        );
      }
      const result = await verify({
        secret: user.twofactorSecret as string,
        token: twoFactorCode as string,
      });
      if (!result.valid) {
        logger.warn("Invalid 2FA code", { email });
        throw unauthorized("Your 2FA code is invalid");
      }
    }

    // Reset failed attempts on successful login
    if (user.failedLoginAttempts > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }
    // generate token
    const accessToken = generateAccessToken(user);
    const { token, family } = await generateRefreshToken(user.id, "user");
    logger.info("Merchant logged in", { userId: user.id, email });
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
    // hash the token
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    // find the user with the hashed token
    const user = await prisma.user.findFirst({
      where: {
        emailVerificationToken: hashedToken,
        emailVerificationTokenExpiresAt: { gt: new Date() }, // not expired
        isEmailVerified: false,
      },
    });
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
    });
    logger.info("Merchant email verified", {
      userId: user.id,
      email: user.email,
    });
  },
  async resendEmailVerification(email: string) {
    // check if the user exists
    const user = await prisma.user.findUnique({
      where: { email },
    });
    if (!user) {
      throw notFound("User not found");
    }
    // check if the user is already verified
    if (user.isEmailVerified) {
      throw badRequest("Your email is already verified.Please log in");
    }
    // generate a new token
    const { emailToken, hashedToken, expiresAt } =
      await generateTemporaryToken();
    user.emailVerificationToken = hashedToken;
    user.emailVerificationTokenExpiresAt = expiresAt;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationToken: hashedToken,
        emailVerificationTokenExpiresAt: expiresAt,
      },
    });
    return { emailToken };
  },
  async refreshMerchantToken(
    refreshToken: string,
    refreshTokenFamily: string,
  ): Promise<AuthTokens> {
    // hash incoming token
    const hashedToken = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");

    // find the token in DB
    const storedToken = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashedToken },
    });

    // token not found
    if (!storedToken) {
      throw unauthorized("Invalid or expired refresh token");
    }

    // ensure token belongs to same family
    if (storedToken.family !== refreshTokenFamily) {
      throw unauthorized("Invalid refresh token family");
    }

    // check if token is expired
    if (storedToken.expiresAt < new Date()) {
      throw unauthorized("Refresh token expired");
    }

    // check reuse / compromise
    if (storedToken.used || storedToken.revoked) {
      logger.warn("Refresh token reuse detected — revoking token family", {
        family: storedToken.family,
        userId: storedToken.userId,
      });

      // revoke entire family (invalidate all sessions for this device)
      await prisma.refreshToken.updateMany({
        where: { family: storedToken.family },
        data: { revoked: true },
      });

      throw unauthorized("Refresh token reuse detected");
    }

    // mark current token as used (rotation step)
    await prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { used: true },
    });

    // get the user linked to this token
    const user = await prisma.user.findUnique({
      where: { id: storedToken.userId! },
    });

    if (!user) {
      throw unauthorized("User not found");
    }

    // generate new access token
    const accessToken = generateAccessToken(user);

    // generate new refresh token (same family = rotation)
    const { token: newRefreshToken, family } = await generateRefreshToken(
      user.id,
      "user",
      storedToken.family,
    );

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
    // hash incoming token
    const hashedToken = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex");
    // find the token in DB
    const storedToken = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashedToken },
    });
    if (!storedToken) return;
    await prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revoked: true },
    });
    logger.info("Merchant logged out", { family: refreshTokenFamily });
    // add to redis blocklist so the refresh token cannot be used again
    await cache.set(`token:revoked:${storedToken.userId}`, true, 15 * 60);
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
    // find the user in the database
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return null;

    // generate reset token
    const { hashedResetToken, resetToken, resetTokenExpiresAt } =
      await generateResetToken();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: hashedResetToken,
        resetTokenExpiresAt: resetTokenExpiresAt,
      },
    });
    // send email to user with password reset link
    logger.info("Password reset token generated for user", {
      userId: user.id,
      email,
    });
    return resetToken;
  },
  async resetMerchantPassword(token: string, newPassword: String) {
    // hash the token
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    // find user with this token
    const user = await prisma.user.findFirst({
      where: {
        resetToken: hashedToken,
        resetTokenExpiresAt: { gt: new Date() },
      },
    });
    if (!user) {
      throw notFound("Invalid or expired reset link");
    }
    // hash the new password
    const hashedPassword = await hashPassword(newPassword.toString());
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiresAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    // Revoke all existing refresh tokens — forces re-login on all devices
    await prisma.refreshToken.updateMany({
      where: { userId: user.id },
      data: { revoked: true },
    });
    logger.info("Merchant password reset", {
      userId: user.id,
      email: user.email,
    });
    // generate a token to login automatically
    const accessToken = generateAccessToken(user);
    const { token: refreshToken, family } = await generateRefreshToken(
      user.id,
      "user",
    );
    return { accessToken, refreshToken, refreshTokenFamily: family };
  },
};
