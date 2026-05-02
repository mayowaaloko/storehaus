import "dotenv/config";
import jwt from "jsonwebtoken";
import { prisma } from "../config/db";
import crypto from "crypto";
import type { StringValue } from "ms";
import type { Request, Response, NextFunction } from "express";

interface TokenUser {
  id: string;
  role: string;
}
type TokenOwnerType = "user" | "customer";

const JWT_SECRET = process.env.JWT_ACCESS_SECRET;
const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN as StringValue;
export const generateAccessToken = (user: TokenUser, res: Response) => {
  const token = jwt.sign(
    {
      id: user.id,
      role: user.role,
      sessionId: crypto.randomUUID(),
    },
    JWT_SECRET as string,
    {
      expiresIn: JWT_ACCESS_EXPIRES_IN,
    },
  );
  res.cookie("jwt", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV == "production" ? "none" : "strict",
    maxAge: 15 * 60 * 1000,
  });

  return token;
};

export const generateRefreshToken = async (
  ownerId: string,
  ownerType: TokenOwnerType,
  res: Response,
  family?: string,
): Promise<{ token: string; family: string }> => {
  const token = crypto.randomBytes(64).toString("hex");
  const tokenFamily = family ?? crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: {
      tokenHash: token,
      family: tokenFamily,
      expiresAt,
      ...(ownerType === "user"
        ? { userId: ownerId, customerId: null }
        : { customerId: ownerId, userId: null }),
    },
  });

  res.cookie("refreshToken", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  return {
    token,
    family: tokenFamily,
  };
};

export const generateTemporaryToken = async () => {
  const emailToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto
    .createHash("sha256")
    .update(emailToken)
    .digest("hex");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  return { hashedToken, emailToken, expiresAt };
};

export const generateResetToken = async () => {
  const resetToken = crypto.randomBytes(32).toString("hex");
  const hashedResetToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");
  const resetTokenExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

  return { hashedResetToken, resetToken, resetTokenExpiresAt };
};
