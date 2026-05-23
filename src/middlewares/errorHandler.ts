import type { Request, Response, NextFunction } from "express";
import { Prisma } from "../generated/prisma";
import jwt from "jsonwebtoken";
import { AppError } from "../utils/appError";
import { logger } from "./logger";

const { JsonWebTokenError, TokenExpiredError } = jwt;
// ─── Dev response — include everything ───────────────────────────────────────

const sendDevError = (err: AppError, res: Response): void => {
  res.status(err.statusCode).json({
    status: err.status,
    message: err.message,
    // stack: err.stack,
    error: err,
  });
};

// ─── Prod response — only send what the client needs ─────────────────────────

const sendProdError = (err: AppError, res: Response): void => {
  if (err.isOperational) {
    res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
    });
  } else {
    res.status(500).json({
      status: "error",
      message: "Something went wrong. Please try again later.",
    });
  }
};

// ─── Prisma error handlers ────────────────────────────────────────────────────

const handlePrismaUniqueConstraint = (
  err: Prisma.PrismaClientKnownRequestError, // ← Prisma.  (not prisma.)
): AppError => {
  const field = (err.meta?.target as string[])?.[0] ?? "field";
  return new AppError(`A record with this ${field} already exists.`, 409);
};

const handlePrismaNotFound = (): AppError => {
  return new AppError("Record not found.", 404);
};

const handlePrismaForeignKey = (
  err: Prisma.PrismaClientKnownRequestError, // ← Prisma.
): AppError => {
  const field = (err.meta?.field_name as string) ?? "related record";
  return new AppError(`Related ${field} does not exist.`, 400);
};

const handlePrismaValidation = (): AppError => {
  return new AppError("Invalid data provided.", 400);
};

// ─── JWT error handlers ───────────────────────────────────────────────────────

const handleJwtInvalid = (): AppError => {
  return new AppError("Invalid token. Please log in again.", 401);
};

const handleJwtExpired = (): AppError => {
  return new AppError("Token has expired. Please log in again.", 401);
};

// ─── Global error handler ─────────────────────────────────────────────────────

export const globalErrorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  logger.error("Request error", {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  if (process.env.NODE_ENV === "development") {
    const appErr =
      err instanceof AppError ? err : new AppError(String(err), 500);
    appErr.isOperational = false;
    sendDevError(appErr, res);
    return;
  }

  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // ← Prisma.
    switch (err.code) {
      case "P2002":
        appError = handlePrismaUniqueConstraint(err);
        break;
      case "P2025":
        appError = handlePrismaNotFound();
        break;
      case "P2003":
        appError = handlePrismaForeignKey(err);
        break;
      case "P2007":
        appError = handlePrismaValidation();
        break;
      default:
        appError = new AppError("Database error.", 500);
        appError.isOperational = false;
    }
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    // ← Prisma.
    appError = new AppError("Invalid data sent to database.", 400);
  } else if (err instanceof JsonWebTokenError) {
    appError = handleJwtInvalid();
  } else if (err instanceof TokenExpiredError) {
    appError = handleJwtExpired();
  } else if (err instanceof Error && err.name === "ZodError") {
    appError = new AppError("Validation failed.", 400);
  } else {
    appError = new AppError("Something went wrong.", 500);
    appError.isOperational = false;
  }

  sendProdError(appError, res);
};
