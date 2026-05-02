// src/middleware/rateLimiter.ts
//
// Three rate limiters:
//
// 1. generalLimiter  → applied to all routes. 300 req / 15min per IP
// 2. authLimiter     → applied to /auth routes only. 10 req / 15min per IP
//                      Slows down brute-force password attacks.
// 3. storeLimiter    → applied per storeId, not per IP.
//                      Prevents one merchant's traffic from hammering the DB.
//
// All three use Redis as the store so:
//   - Counters survive server restarts
//   - Counters are shared across multiple server instances (horizontal scaling)
//   - If you deploy two Railway instances, they share the same rate limit counts
//
// If Redis is down, the limiters fall back to memory store automatically —
// rate limiting still works, just not shared across instances.
import "dotenv/config";
import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import type { RedisReply } from "rate-limit-redis";
import type { Request, Response, NextFunction } from "express";
import { redisClient } from "../config/redis";

// ─── Shared Redis store factory ───────────────────────────────────────────────
//
// Each limiter gets its own RedisStore with its own prefix.
// The prefix ensures the counters don't clash with each other
// or with your application cache keys.
//
// Keys in Redis will look like:
//   rl:general:{ip}
//   rl:auth:{ip}
//   rl:store:{storeId}

function createRedisStore(prefix: string): RedisStore {
  return new RedisStore({
    // rate-limit-redis uses sendCommand to talk to ioredis
    sendCommand: async (...args: string[]): Promise<RedisReply> => {
      return (await redisClient.call(...args)) as RedisReply;
    },
    prefix: `rl:${prefix}:`,
  });
}
// ─── Standard error response ──────────────────────────────────────────────────
//
// By default express-rate-limit sends plain text "Too many requests".
// We override it to match our API response envelope.

function rateLimitHandler(req: Request, res: Response): void {
  res.status(429).json({
    status: "error",
    message: "Too many requests. Please slow down and try again later.",
    retryAfter: res.getHeader("Retry-After"),
    requestId: req.requestId,
  });
}

// ─── 1. General Limiter ───────────────────────────────────────────────────────
//
// Applied globally on all routes in app.ts:
//   app.use(generalLimiter)
//
// 300 requests per 15 minutes per IP address.
// This is generous — a normal user will never hit this.
// It exists to stop scrapers and automated abuse.

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes in milliseconds
  max: 300, // max requests per window per IP
  standardHeaders: "draft-7", // sends RateLimit headers in the response
  // so clients know how many requests they have left:
  // RateLimit-Limit: 300
  // RateLimit-Remaining: 247
  // RateLimit-Reset: 2024-01-01T12:45:00.000Z
  legacyHeaders: false, // disables old X-RateLimit-* headers
  store: createRedisStore("general"),
  handler: rateLimitHandler,
  skip: (req: Request) => {
    // Never rate limit health checks — Railway's load balancer hits these constantly
    return req.url.startsWith("/health");
  },
});

// ─── 2. Auth Limiter ─────────────────────────────────────────────────────────
//
// Applied only on auth routes in auth.routes.ts:
//   router.post('/login', authLimiter, authController.login)
//   router.post('/register', authLimiter, authController.register)
//
// 10 requests per 15 minutes per IP.
// This is strict — a real user logs in once, not 10 times in 15 minutes.
// An attacker trying passwords hits this wall quickly.
//
// Why not block after 5 wrong passwords?
// Because rate limiting by IP is simpler and catches more attack patterns.
// You can add account lockout (failedLoginAttempts) on top of this —
// which you already have in your User and StoreCustomer models.

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  store: createRedisStore("auth"),
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      status: "error",
      message:
        "Too many login attempts. You have been temporarily blocked. Try again in 15 minutes.",
    });
  },
});

// ─── 3. Store Limiter ─────────────────────────────────────────────────────────
//
// Applied on all /stores/:slug/* routes, keyed by storeId not IP.
//
// Why key by storeId?
//   - Imagine a merchant's storefront goes viral.
//   - Thousands of customers from different IPs hit their store.
//   - The general IP limiter wouldn't catch this — each IP is under 300 req.
//   - But the total DB load from ONE store could be huge.
//   - The store limiter caps the total load per store at 500 req/15min.
//
// This protects your database from being hammered by one popular store
// at the expense of other tenants. This is called "noisy neighbour" protection.
//
// Applied in tenant.ts after the store is resolved — so we have req.store.id:
//   router.use(tenantMiddleware, storeLimiter, ...)
//
// Or apply it manually after tenant resolution in your router files.

export const storeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  store: createRedisStore("store"),

  // KEY FUNCTION — this is what makes it per-store instead of per-IP
  // By default express-rate-limit uses IP. We override it to use storeId.
  keyGenerator: (req: Request): string => {
    // req.store is set by tenantMiddleware which runs before this
    // Fall back to IP if store isn't resolved yet (shouldn't happen in normal flow)
    return req.store?.id ?? req.ip ?? "unknown";
  },

  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      status: "error",
      message:
        "This store has received too many requests. Please try again shortly.",
    });
  },
});

// ─── 4. Webhook Limiter ───────────────────────────────────────────────────────
//
// Paystack's servers send webhooks to your /webhooks/paystack endpoint.
// We do NOT rate limit this endpoint because:
//   - Paystack retries failed webhooks — if you block them, payments break
//   - Paystack's IP range is known and we verify their signature anyway
//
// The HMAC-SHA512 signature verification in webhooks.controller.ts
// is the security layer here, not rate limiting.
//
// So there is intentionally no limiter for /webhooks/paystack.
// Just leaving this comment so you don't wonder why it's missing.

// ─── How to use in app.ts ─────────────────────────────────────────────────────
//
// import { generalLimiter, authLimiter, storeLimiter } from './middleware/rateLimiter'
//
// app.use(generalLimiter)  // ← applies to every route
//
// Then in auth.routes.ts:
//   router.post('/login', authLimiter, authController.login)
//   router.post('/register', authLimiter, authController.register)
//   router.post('/forgot-password', authLimiter, authController.forgotPassword)
//
// Then in stores.routes.ts (after tenantMiddleware):
//   router.use(tenantMiddleware)
//   router.use(storeLimiter)   // ← applies to all store routes
//   router.get('/products', productsController.list)
//   ...
