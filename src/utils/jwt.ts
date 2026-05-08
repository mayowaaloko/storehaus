import "dotenv/config";
import jwt from "jsonwebtoken";
import { prisma } from "../config/db";
import crypto from "crypto";
import type { StringValue } from "ms";

interface TokenUser {
  id: string;
  role: string;
  storeId?: string;
}
type TokenOwnerType = "user" | "customer";

const JWT_SECRET = process.env.JWT_ACCESS_SECRET;
const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN as StringValue;

export const generateAccessToken = (user: TokenUser) => {
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
  ); // sign jwt access token
  return token;
};

export const generateRefreshToken = async (
  ownerId: string,
  ownerType: TokenOwnerType,
  family?: string,
): Promise<{ token: string; family: string }> => {
  const token = crypto.randomBytes(64).toString("hex"); // generate random refresh token
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex"); // hash it
  const tokenFamily = family ?? crypto.randomUUID(); // use existing or new family
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days expiry

  await prisma.refreshToken.create({
    data: {
      tokenHash: hashedToken,
      family: tokenFamily,
      expiresAt,
      ...(ownerType === "user"
        ? { userId: ownerId, customerId: null }
        : { customerId: ownerId, userId: null }),
    },
  }); // save to db

  return {
    token,
    family: tokenFamily,
  };
};

export const generateTemporaryToken = async () => {
  const emailToken = crypto.randomBytes(32).toString("hex"); // plain token
  const hashedToken = crypto
    .createHash("sha256")
    .update(emailToken)
    .digest("hex"); // hashed version
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  return { hashedToken, emailToken, expiresAt };
};

export const generateResetToken = async () => {
  const resetToken = crypto.randomBytes(32).toString("hex"); // plain reset token
  const hashedResetToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex"); // hashed
  const resetTokenExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  return { hashedResetToken, resetToken, resetTokenExpiresAt };
};
