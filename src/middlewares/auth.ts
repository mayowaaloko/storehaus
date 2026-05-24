// src/middlewares/auth.ts

import jwt from "jsonwebtoken";
import { forbidden, unauthorized } from "../utils/appError";
import { catchAsync } from "../utils/catchAsync";
import { prisma } from "../config/db";
import { createRequestLogger } from "../middlewares/logger";
import type { Request, Response, NextFunction } from "express";

// ─── protect ──────────────────────────────────────────────────────────────────
//
// Verifies the JWT access token on every protected route.
// Supports two token sources:
//   1. Authorization: Bearer <token>  ← standard, what Postman and most clients use
//   2. req.cookies.jwt               ← for browser clients using httpOnly cookies
//
// After verification it looks up the user in the DB to confirm they still exist
// and are still active. This costs one DB query per request but means a
// deactivated account is rejected immediately, not after the token expires.
//
// Populates:
//   req.user     → the full User or StoreCustomer record
//   req.userType → "user" (merchant/admin) or "customer"

export const protect = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const log = createRequestLogger(req);
    let token: string | undefined;

    // Extract token
    if (req.headers.authorization?.startsWith("Bearer")) {
      token = req.headers.authorization.split(" ")[1];
    } else if (req.cookies?.jwt) {
      token = req.cookies.jwt;
    }

    if (!token) {
      log.warn("Missing authentication token");
      return next(
        unauthorized("You are not logged in. Please log in to get access"),
      );
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as {
        id: string;
        role: string;
      };
    } catch (err) {
      log.warn("Invalid or expired token");
      return next(
        unauthorized("Invalid or expired token. Please log in again"),
      );
    }

    // Try Merchant/User first (most common)
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (user) {
      if (!user.isActive) {
        log.warn("Deactivated account tried to access", { userId: user.id });
        return next(
          forbidden("Your account has been deactivated. Contact support."),
        );
      }

      req.user = user;
      req.userType = "user";
      return next();
    }

    // Try Customer
    const customer = await prisma.storeCustomer.findUnique({
      where: { id: decoded.id },
    });

    if (customer) {
      if (!customer.isActive) {
        return next(forbidden("Your account has been deactivated."));
      }

      req.user = customer;
      req.userType = "customer";
      return next();
    }

    // Token is valid but no user/customer found
    log.warn("Valid token but user not found", { id: decoded.id });
    return next(unauthorized("User not found. Please log in again."));
  },
);

// ─── restrictTo ───────────────────────────────────────────────────────────────
//
// Role-based access control. Run AFTER protect.
//
// Usage:
//   router.get("/admin/stores", protect, restrictTo("SUPER_ADMIN"), ...)
//   router.post("/products",    protect, restrictTo("MERCHANT", "SUPER_ADMIN"), ...)
//
// Customers are always blocked — they have no role in the UserRole enum.
// Only merchants and admins have roles.

export const restrictTo = (...allowedRoles: string[]) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const log = createRequestLogger(req);

    if (!req.user || !req.userType) {
      return next(unauthorized("You must be logged in to perform this action"));
    }

    // Customers have no role — block them from all merchant/admin routes
    if (req.userType === "customer") {
      log.warn("Customer attempted to access merchant route", {
        path: req.path,
      });
      return next(
        forbidden("You do not have permission to perform this action"),
      );
    }

    // Check the merchant/admin's role
    const role = (req.user as any).role;

    if (!role || !allowedRoles.includes(role)) {
      log.warn("Insufficient role for route", {
        userRole: role,
        allowedRoles,
        path: req.path,
      });
      return next(
        forbidden("You do not have permission to perform this action"),
      );
    }

    next();
  });

// ─── requireStoreOwner ────────────────────────────────────────────────────────
//
// Confirms the authenticated merchant owns the store in req.store.
// Run AFTER both protect AND tenantMiddleware — it needs both req.user
// and req.store to already be populated.
//
// Usage:
//   router.put("/:slug", protect, tenantMiddleware, requireStoreOwner, ...)
//   router.delete("/:slug", protect, tenantMiddleware, requireStoreOwner, ...)
//
// SUPER_ADMIN bypasses this check — they can access and modify any store
// on the platform. Merchants can only touch their own store.

export const requireStoreOwner = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const log = createRequestLogger(req);

    // protect must have run first
    if (!req.user || !req.userType) {
      return next(unauthorized("You must be logged in"));
    }

    // Customers can never be store owners
    if (req.userType === "customer") {
      return next(
        forbidden("You do not have permission to perform this action"),
      );
    }

    const user = req.user as any;

    // SUPER_ADMIN can access any store — no ownership check needed
    if (user.role === "SUPER_ADMIN") {
      return next();
    }

    // tenantMiddleware must have run first — req.store must exist
    if (!req.store) {
      log.error("requireStoreOwner ran before tenantMiddleware", {
        path: req.path,
      });
      return next(forbidden("Store context not found"));
    }

    // req.store.ownerId is set by tenantMiddleware from the DB
    // user.id is the merchant's ID from the JWT
    // These must match — a merchant cannot modify another merchant's store
    const storeOwnerId = (req.store as any).ownerId;

    if (storeOwnerId !== user.id) {
      log.warn("Merchant attempted to access another merchant's store", {
        merchantId: user.id,
        storeOwnerId,
        storeId: req.store.id,
      });
      return next(forbidden("You do not have access to this store"));
    }

    // Ownership confirmed — let the request through
    next();
  },
);

export const requireCustomer = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.userType !== "customer") {
      return next(forbidden("Only customers can perform this action"));
    }
    next();
  },
);
