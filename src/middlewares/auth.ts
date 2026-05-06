import jwt from "jsonwebtoken";
import { AppError, forbidden, unauthorized } from "../utils/appError";
import { catchAsync } from "../utils/catchAsync";
import { prisma } from "../config/db";
import { createRequestLogger } from "../middlewares/logger";
import type { Request, Response, NextFunction } from "express";

export const protect = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const log = createRequestLogger(req);
    let token;

    if (req.headers.authorization?.startsWith("Bearer")) {
      token = req.headers.authorization.split(" ")[1];
    } else if (req.cookies?.jwt) {
      token = req.cookies.jwt;
    }

    if (!token) {
      log.warn("Missing authentication token", {
        ip: req.ip,
        path: req.path,
        method: req.method,
        userAgent: req.get("User-Agent"),
      });
      return next(
        unauthorized("You are not logged in. Please log in to get access"),
      );
    }

    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as {
      id: string;
      role: string;
    };

    // ── 1. Try Merchant / Admin (User table) ───────────────────────────────
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (user) {
      if (!user.isActive) {
        log.warn("User account deactivated", {
          ip: req.ip,
          path: req.path,
          method: req.method,
          userAgent: req.get("User-Agent"),
          userId: decoded.id,
        });
        return next(
          forbidden("Your account has been deactivated. Contact support."),
        );
      }
      req.user = user;
      req.userType = "user";
      return next();
    }

    // ── 2. Try Store Customer ──────────────────────────────────────────────
    const customer = await prisma.storeCustomer.findUnique({
      where: { id: decoded.id },
    });

    if (customer) {
      req.user = customer;
      req.userType = "customer";
      return next();
    }

    // ── 3. Not found in either table ───────────────────────────────────────
    log.warn("User not found or inactive", {
      ip: req.ip,
      path: req.path,
      method: req.method,
      userAgent: req.get("User-Agent"),
      userId: decoded.id,
    });
    log.error("Authentication failed: user not found in any table", {
      userId: decoded.id,
    });
    return next(unauthorized("User not found. Access denied."));
  },
);

export const restrictTo = (...allowedRoles: string[]) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const log = createRequestLogger(req);

    if (!req.user) {
      log.warn("Access restricted: user not authenticated");
      return next(
        unauthorized("You do not have permission to perform this action"),
      );
    }
    if (req.userType === "customer") {
      return next(
        unauthorized("You do not have permission to perform this action"),
      );
    }
    let userRole: string | undefined;
    if (req.userType === "user") {
      const dbUser = req.user as { role: string };
      userRole = dbUser.role;
    }
    if (!userRole || !allowedRoles.includes(userRole)) {
      log.warn("Access restricted: insufficient permissions", {
        userRole,
        allowedRoles,
      });
      return next(
        unauthorized("You do not have permission to perform this action"),
      );
    }

    next();
  });
