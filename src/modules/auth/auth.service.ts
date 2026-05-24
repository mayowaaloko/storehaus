// Unified authentication service for the entire platform.
// Handles both:
//   • Merchants / Super Admins  → User model  → req.userType = "user"
//   • Store Customers           → StoreCustomer model → req.userType = "customer"
//
// Refresh tokens and logout are generic — they look at the token record to
// decide whether it belongs to a merchant or a customer and handle accordingly.

import crypto from "crypto";
import { prisma } from "../../config/db";
import {
  AppError,
  badRequest,
  conflict,
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

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_FAILED_ATTEMPTS = 5; // lock account after 5 wrong passwords
const LOCK_DURATION_MINUTES = 30; // locked for 30 minutes
const RESET_TOKEN_EXPIRES_MINUTES = 10;

// ─── Interfaces ───────────────────────────────────────────────────────────────

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

// ─── Helper: generic token refresh core ──────────────────────────────────────
// Both merchant and customer refresh flows share the same RefreshToken table.
// This helper looks up the token, validates it, rotates it, and returns new
// tokens plus the actor type so the controller knows what to send back.

async function performRefresh(
  rawRefreshToken: string,
  refreshTokenFamily: string,
): Promise<AuthTokens & { actorType: "user" | "customer"; actorId: string }> {
  const hashedToken = crypto
    .createHash("sha256")
    .update(rawRefreshToken)
    .digest("hex");

  const storedToken = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashedToken },
  });

  if (!storedToken) throw unauthorized("Invalid or expired refresh token");
  if (storedToken.family !== refreshTokenFamily)
    throw unauthorized("Invalid refresh token family");
  if (storedToken.expiresAt < new Date())
    throw unauthorized("Refresh token expired");

  if (storedToken.used || storedToken.revoked) {
    logger.warn("Refresh token reuse detected — revoking token family", {
      family: storedToken.family,
    });
    await prisma.refreshToken.updateMany({
      where: { family: storedToken.family },
      data: { revoked: true },
    });
    throw unauthorized("Refresh token reuse detected");
  }

  await prisma.refreshToken.update({
    where: { id: storedToken.id },
    data: { used: true },
  });

  let accessToken: string;
  let newRefreshToken: string;
  let family: string;
  let actorType: "user" | "customer";
  let actorId: string;

  if (storedToken.userId) {
    // ── Merchant token ────────────────────────────────────────────────────
    const user = await prisma.user.findUnique({
      where: { id: storedToken.userId },
    });
    if (!user) throw unauthorized("User not found");

    accessToken = generateAccessToken({
      id: user.id,
      role: user.role,
    });
    ({ token: newRefreshToken, family } = await generateRefreshToken(
      user.id,
      "user",
      storedToken.family,
    ));
    actorType = "user";
    actorId = user.id;
  } else if (storedToken.customerId) {
    // ── Customer token ────────────────────────────────────────────────────
    const customer = await prisma.storeCustomer.findUnique({
      where: { id: storedToken.customerId },
    });
    if (!customer) throw unauthorized("Customer not found");

    accessToken = generateAccessToken({
      id: customer.id,
      role: "CUSTOMER",
      storeId: customer.storeId,
    });
    ({ token: newRefreshToken, family } = await generateRefreshToken(
      customer.id,
      "customer",
      storedToken.family,
    ));
    actorType = "customer";
    actorId = customer.id;
  } else {
    throw unauthorized("Invalid token association");
  }

  return {
    accessToken,
    refreshToken: newRefreshToken,
    refreshTokenFamily: family,
    actorType,
    actorId,
  };
}

// ─── Helper: generic logout core ─────────────────────────────────────────────
// Revokes the token and adds it to a short-lived blocklist in Redis.
// Works for both userId-linked and customerId-linked tokens.

async function performLogout(
  rawRefreshToken: string,
  refreshTokenFamily: string,
): Promise<void> {
  const hashedToken = crypto
    .createHash("sha256")
    .update(rawRefreshToken)
    .digest("hex");

  const storedToken = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashedToken },
  });
  if (!storedToken) return;

  await prisma.refreshToken.update({
    where: { id: storedToken.id },
    data: { revoked: true },
  });

  const blocklistKey = storedToken.userId
    ? `token:revoked:${storedToken.userId}`
    : `token:revoked:customer:${storedToken.customerId}`;

  await cache.set(blocklistKey, true, 15 * 60);
  await cache.set(
    `token:family:${storedToken.userId ?? storedToken.customerId}`,
    storedToken.family,
    15 * 60,
  );

  logger.info("Logged out and token blocked", {
    family: refreshTokenFamily,
    actorId: storedToken.userId ?? storedToken.customerId,
  });
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const AuthService = {
  // ═══════════════════════════════════════════════════════════════════════════
  // MERCHANT AUTH
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Register merchant ──────────────────────────────────────────────────────

  async registerMerchant(input: MerchantRegisterInput) {
    const { email, password, firstName, lastName, phoneNumber } = input;
    const normalizedEmail = email.toLowerCase();

    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingUser) throw conflict("User with this email already exists");

    const hashedPassword = await hashPassword(password);
    const { emailToken, hashedToken, expiresAt } =
      await generateTemporaryToken();

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

  // ── Login merchant ─────────────────────────────────────────────────────────

  async loginMerchant(
    email: string,
    password: string,
    twoFactorCode: string | undefined,
  ): Promise<AuthTokens & { user: object }> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw unauthorized("Invalid credentials");

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minuteLeft = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / (1000 * 60),
      );
      logger.info("Account is locked", { userId: user.id, minuteLeft });
      throw locked(`Account is locked. Try again in ${minuteLeft} minutes`);
    }

    if (!user.isActive)
      throw notFound("Your account has been deactivated. Contact support.");

    const passwordValid = await comparePassword(password, user.password);
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
      });

      if (shouldLock) {
        logger.warn("Merchant account locked after failed attempts", { email });
        throw locked("Account locked due to multiple failed attempts");
      }
      throw unauthorized("Invalid credentials");
    }

    if (user.twofactorEnabled) {
      if (!user.twofactorSecret || !twoFactorCode)
        throw serverError(
          "Two-factor authentication is enabled but not configured. Please contact support",
        );
      const result = await verify({
        secret: user.twofactorSecret,
        token: twoFactorCode,
      });
      if (!result.valid) {
        logger.warn("Invalid 2FA code", { email });
        throw unauthorized("Your 2FA code is invalid");
      }
    }

    if (user.failedLoginAttempts > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    const accessToken = generateAccessToken({
      id: user.id,
      role: user.role,
    });
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

  // ── Verify merchant email ──────────────────────────────────────────────────

  async verifyMerchantEmail(token: string) {
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await prisma.user.findFirst({
      where: {
        emailVerificationToken: hashedToken,
        emailVerificationTokenExpiresAt: { gt: new Date() },
        isEmailVerified: false,
      },
    });
    if (!user) throw notFound("Invalid or expired verification link");

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

  // ── Resend merchant verification ───────────────────────────────────────────

  async resendMerchantEmailVerification(email: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw notFound("User not found");
    if (user.isEmailVerified)
      throw badRequest("Your email is already verified. Please log in");

    const { emailToken, hashedToken, expiresAt } =
      await generateTemporaryToken();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationToken: hashedToken,
        emailVerificationTokenExpiresAt: expiresAt,
      },
    });

    return { emailToken };
  },

  // ── Refresh merchant token ─────────────────────────────────────────────────
  // Thin wrapper around the generic refresh core.

  async refreshMerchantToken(
    refreshToken: string,
    refreshTokenFamily: string,
  ): Promise<AuthTokens> {
    const result = await performRefresh(refreshToken, refreshTokenFamily);
    if (result.actorType !== "user")
      throw unauthorized("Invalid token type for merchant");
    logger.info("Merchant access token refreshed", {
      userId: result.actorId,
      family: result.refreshTokenFamily,
    });
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      refreshTokenFamily: result.refreshTokenFamily,
    };
  },

  // ── Logout merchant ────────────────────────────────────────────────────────
  // Thin wrapper around the generic logout core.

  async logoutMerchant(
    refreshToken: string,
    refreshTokenFamily: string,
  ): Promise<void> {
    return performLogout(refreshToken, refreshTokenFamily);
  },

  // ── Forgot merchant password ───────────────────────────────────────────────

  async forgotMerchantPassword(email: string): Promise<string | null> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return null;

    const { hashedResetToken, resetToken, resetTokenExpiresAt } =
      await generateResetToken();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: hashedResetToken,
        resetTokenExpiresAt,
      },
    });

    logger.info("Password reset token generated for merchant", {
      userId: user.id,
      email,
    });
    return resetToken;
  },

  // ── Reset merchant password ────────────────────────────────────────────────

  async resetMerchantPassword(token: string, newPassword: string) {
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await prisma.user.findFirst({
      where: {
        resetToken: hashedToken,
        resetTokenExpiresAt: { gt: new Date() },
      },
    });
    if (!user) throw notFound("Invalid or expired reset link");

    const hashedPassword = await hashPassword(newPassword);

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

    await prisma.refreshToken.updateMany({
      where: { userId: user.id },
      data: { revoked: true },
    });

    logger.info("Merchant password reset", {
      userId: user.id,
      email: user.email,
    });

    const accessToken = generateAccessToken({
      id: user.id,
      role: user.role,
    });
    const { token: refreshToken, family } = await generateRefreshToken(
      user.id,
      "user",
    );

    return { accessToken, refreshToken, refreshTokenFamily: family };
  },

  // ── Update merchant password ───────────────────────────────────────────────

  async updateMerchantPassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<AuthTokens> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound("User not found");

    const isOldPasswordValid = await comparePassword(
      oldPassword,
      user.password,
    );
    if (!isOldPasswordValid)
      throw unauthorized("Current password is incorrect");

    const hashedPassword = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    await prisma.refreshToken.updateMany({
      where: { userId: user.id },
      data: { revoked: true },
    });

    logger.info("Merchant password updated", { userId: user.id });

    const accessToken = generateAccessToken({
      id: user.id,
      role: user.role,
    });
    const { token, family } = await generateRefreshToken(user.id, "user");

    return { accessToken, refreshToken: token, refreshTokenFamily: family };
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOMER AUTH
  // ═══════════════════════════════════════════════════════════════════════════
  // Scoped to a single store. A customer can have separate accounts in
  // different stores with the same email.

  // ── Register customer ────────────────────────────────────────────────────────

  async registerCustomer(input: CustomerRegisterInput) {
    const { email, password, firstName, lastName, phoneNumber, storeId } =
      input;

    const existing = await prisma.storeCustomer.findUnique({
      where: { storeId_email: { storeId, email } },
    });
    if (existing)
      throw conflict("An account with this email already exists in this store");

    const hashedPassword = await hashPassword(password);
    const { emailToken, hashedToken, expiresAt } =
      await generateTemporaryToken();

    const customer = await prisma.storeCustomer.create({
      data: {
        email,
        password: hashedPassword,
        firstName,
        lastName,
        phoneNumber,
        storeId,
        emailVerificationToken: hashedToken,
        emailVerificationTokenExpiresAt: expiresAt,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isEmailVerified: true,
        createdAt: true,
      },
    });

    logger.info("Customer registered", {
      customerId: customer.id,
      storeId,
    });
    return { customer, emailToken };
  },

  // ── Login customer ─────────────────────────────────────────────────────────

  async loginCustomer(
    email: string,
    password: string,
    storeId: string,
  ): Promise<AuthTokens & { customer: object }> {
    const customer = await prisma.storeCustomer.findUnique({
      where: { storeId_email: { storeId, email } },
    });
    if (!customer) throw unauthorized("Invalid email or password");

    if (customer.lockedUntil && customer.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (customer.lockedUntil.getTime() - Date.now()) / 60000,
      );
      throw locked(`Account locked. Try again in ${minutesLeft} minutes`);
    }
    if (!customer.password) {
      throw unauthorized("Please set a password for this account");
    }
    const passwordValid = await comparePassword(password, customer.password);

    if (!passwordValid) {
      const newFailedAttempts = customer.failedLoginAttempts + 1;
      const shouldLock = newFailedAttempts >= MAX_FAILED_ATTEMPTS;

      await prisma.storeCustomer.update({
        where: { id: customer.id },
        data: {
          failedLoginAttempts: newFailedAttempts,
          lockedUntil: shouldLock
            ? new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000)
            : null,
        },
      });

      if (shouldLock) {
        logger.warn("Customer account locked after failed attempts", {
          email,
          storeId,
        });
        throw locked("Account locked due to multiple failed attempts");
      }
      throw unauthorized("Invalid email or password");
    }

    if (customer.failedLoginAttempts > 0) {
      await prisma.storeCustomer.update({
        where: { id: customer.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    const accessToken = generateAccessToken({
      id: customer.id,
      role: "CUSTOMER",
      storeId: customer.storeId,
    });
    const { token, family } = await generateRefreshToken(
      customer.id,
      "customer",
    );

    logger.info("Customer logged in", {
      customerId: customer.id,
      storeId,
    });

    return {
      accessToken,
      refreshToken: token,
      refreshTokenFamily: family,
      customer: {
        id: customer.id,
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        isEmailVerified: customer.isEmailVerified,
      },
    };
  },

  // ── Verify customer email ──────────────────────────────────────────────────

  async verifyCustomerEmail(token: string) {
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const customer = await prisma.storeCustomer.findFirst({
      where: {
        emailVerificationToken: hashedToken,
        emailVerificationTokenExpiresAt: { gt: new Date() },
        isEmailVerified: false,
      },
    });
    if (!customer) throw notFound("Invalid or expired verification link");

    await prisma.storeCustomer.update({
      where: { id: customer.id },
      data: {
        isEmailVerified: true,
        emailVerificationToken: null,
        emailVerificationTokenExpiresAt: null,
      },
    });

    logger.info("Customer email verified", {
      customerId: customer.id,
      email: customer.email,
    });
  },

  // ── Resend customer verification ───────────────────────────────────────────

  async resendCustomerEmailVerification(email: string, storeId: string) {
    const customer = await prisma.storeCustomer.findUnique({
      where: { storeId_email: { storeId, email } },
    });
    if (!customer) throw notFound("Customer not found");
    if (customer.isEmailVerified)
      throw badRequest("Your email is already verified. Please log in");

    const { emailToken, hashedToken, expiresAt } =
      await generateTemporaryToken();

    await prisma.storeCustomer.update({
      where: { id: customer.id },
      data: {
        emailVerificationToken: hashedToken,
        emailVerificationTokenExpiresAt: expiresAt,
      },
    });

    return { emailToken };
  },

  // ── Refresh customer token ─────────────────────────────────────────────────

  async refreshCustomerToken(
    refreshToken: string,
    refreshTokenFamily: string,
  ): Promise<AuthTokens> {
    const result = await performRefresh(refreshToken, refreshTokenFamily);
    if (result.actorType !== "customer")
      throw unauthorized("Invalid token type for customer");
    logger.info("Customer access token refreshed", {
      customerId: result.actorId,
      family: result.refreshTokenFamily,
    });
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      refreshTokenFamily: result.refreshTokenFamily,
    };
  },

  // ── Logout customer ────────────────────────────────────────────────────────

  async logoutCustomer(
    refreshToken: string,
    refreshTokenFamily: string,
  ): Promise<void> {
    return performLogout(refreshToken, refreshTokenFamily);
  },

  // ── Forgot customer password ───────────────────────────────────────────────
  // Scoped to store — same email can exist across multiple stores.

  async forgotCustomerPassword(
    email: string,
    storeId: string,
  ): Promise<string | null> {
    const customer = await prisma.storeCustomer.findUnique({
      where: { storeId_email: { storeId, email } },
    });
    if (!customer) return null;

    const { hashedResetToken, resetToken, resetTokenExpiresAt } =
      await generateResetToken();

    await prisma.storeCustomer.update({
      where: { id: customer.id },
      data: {
        resetToken: hashedResetToken,
        resetTokenExpiresAt,
      },
    });

    logger.info("Password reset token generated for customer", {
      customerId: customer.id,
      storeId,
    });
    return resetToken;
  },

  // ── Reset customer password ────────────────────────────────────────────────

  async resetCustomerPassword(token: string, newPassword: string) {
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const customer = await prisma.storeCustomer.findFirst({
      where: {
        resetToken: hashedToken,
        resetTokenExpiresAt: { gt: new Date() },
      },
    });
    if (!customer) throw notFound("Invalid or expired reset link");

    const hashedPassword = await hashPassword(newPassword);

    await prisma.storeCustomer.update({
      where: { id: customer.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiresAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    await prisma.refreshToken.updateMany({
      where: { customerId: customer.id },
      data: { revoked: true },
    });

    logger.info("Customer password reset", {
      customerId: customer.id,
      email: customer.email,
    });

    const accessToken = generateAccessToken({
      id: customer.id,
      role: "CUSTOMER",
      storeId: customer.storeId,
    });
    const { token: refreshToken, family } = await generateRefreshToken(
      customer.id,
      "customer",
    );

    return { accessToken, refreshToken, refreshTokenFamily: family };
  },

  // ── Update customer password ───────────────────────────────────────────────

  async updateCustomerPassword(
    customerId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<AuthTokens> {
    const customer = await prisma.storeCustomer.findUnique({
      where: { id: customerId },
    });
    if (!customer) throw notFound("Customer not found");

    const isOldPasswordValid = await comparePassword(
      oldPassword,
      customer.password ?? "",
    );
    if (!isOldPasswordValid)
      throw unauthorized("Current password is incorrect");

    const hashedPassword = await hashPassword(newPassword);

    await prisma.storeCustomer.update({
      where: { id: customer.id },
      data: { password: hashedPassword },
    });

    await prisma.refreshToken.updateMany({
      where: { customerId: customer.id },
      data: { revoked: true },
    });

    logger.info("Customer password updated", { customerId: customer.id });

    const accessToken = generateAccessToken({
      id: customer.id,
      role: "CUSTOMER",
      storeId: customer.storeId,
    });
    const { token, family } = await generateRefreshToken(
      customer.id,
      "customer",
    );

    return { accessToken, refreshToken: token, refreshTokenFamily: family };
  },
};
