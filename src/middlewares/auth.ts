import jwt from "jsonwebtoken";
import AppError from "../utils/appError";
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
        new AppError("You are not logged in. Please log in to get access", 401),
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
          new AppError(
            "Your account has been deactivated. Contact support.",
            403,
          ),
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
    return next(new AppError("User not found. Access denied.", 401));
  },
);
