// src/middleware/logger.ts
//
// Two things happen here:
//
// 1. Winston logger — the single logger instance the whole app uses.
//    Every log line goes through this. Never use console.log in the app.
//
// 2. Morgan middleware — logs every HTTP request (method, path, status,
//    response time). Morgan is configured to send its output through
//    Winston so all logs are in one place with the same format.
import "dotenv/config";
import winston from "winston";
import morgan from "morgan";
import type { Request, Response, NextFunction } from "express";

// ─── Winston Logger ───────────────────────────────────────────────────────────
//
// Development format: coloured, human-readable, easier to scan in terminal
//   12:45:03 [info]  Server running on port 3000
//   12:45:04 [debug] Cache miss for key "store:techvault"
//
// Production format: JSON, one line per log entry, machine-readable
//   {"level":"info","message":"Order created","orderId":"clx...","timestamp":"2024-01-01T12:45:03.000Z"}
//
// Production JSON logs can be ingested by Railway's log viewer,
// Datadog, Logtail, Sentry, etc. for searching and alerting.

const developmentFormat = winston.format.combine(
  winston.format.colorize({ all: true }), // adds colour to level label
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.errors({ stack: true }), // includes stack trace on errors
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    // If there are extra fields (like orderId, storeId), append them
    const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    // If there's a stack trace (error logs), show it on next line
    const stackTrace = stack ? `\n${stack}` : "";
    return `${timestamp} [${level}] ${message}${extras}${stackTrace}`;
  }),
);

const productionFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(), // outputs everything as a single JSON object per line
);

export const logger = winston.createLogger({
  // In production only log 'info' and above (info, warn, error)
  // In development also log 'debug' (verbose, useful during building)
  level: process.env.NODE_ENV === "production" ? "info" : "debug",

  format:
    process.env.NODE_ENV === "production"
      ? productionFormat
      : developmentFormat,

  transports: [
    // Always log to console (Railway captures stdout automatically)
    new winston.transports.Console(),

    // Optional: write errors to a file in production
    // Uncomment if your hosting gives you persistent disk
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],

  // If Winston itself crashes while logging, don't crash the app
  exitOnError: false,
});

// ─── Morgan HTTP Request Logger ───────────────────────────────────────────────
//
// Morgan logs one line per HTTP request:
//   POST /api/v1/stores/techvault/orders 201 - 84ms
//
// We bridge Morgan into Winston so it uses the same format + transport.
// This means in development it's coloured, in production it's JSON.
//
// We use the 'combined' format which logs:
//   method, url, status, response-time, content-length, user-agent, referrer
//
// The `skip` function skips health check logs — they hit every few seconds
// from Railway's load balancer and would flood your logs with noise.

const morganMiddleware = morgan("combined", {
  stream: {
    // Morgan writes a string — we trim the newline and pass to Winston
    write: (message: string) => {
      logger.http(message.trim());
    },
  },
  skip: (req: Request) => {
    // Skip health check endpoints — too noisy
    return req.url.startsWith("/health");
  },
});

export { morganMiddleware };

// ─── Request ID Middleware ────────────────────────────────────────────────────
//
// Every request gets a unique ID. This ID:
//   1. Is sent back to the client as X-Request-Id header
//   2. Is attached to req so controllers can log with it
//   3. Lets you search logs for one specific request:
//      grep "req_01J..." logs → see every log line from that request
//
// When a merchant reports "I got an error at 3pm", you ask for the
// request ID from the response headers and find everything instantly.

import { nanoid } from "nanoid";

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = `req_${nanoid(12)}`;

  (req as Request & { requestId: string }).requestId = requestId;

  // Send it back so the client (or merchant) can report it to you
  res.setHeader("X-Request-Id", requestId);

  next();
}

// ─── Child logger helper ──────────────────────────────────────────────────────
//
// Creates a logger that automatically includes requestId and storeId
// in every log line — so you never have to pass them manually.
//
// Usage in a controller or service:
//   const log = createRequestLogger(req)
//   log.info('Order created', { orderId: order.id })
//
// Output:
//   { level: "info", message: "Order created", orderId: "clx...",
//     requestId: "req_abc123", storeId: "clx...", timestamp: "..." }

export function createRequestLogger(req: Request): winston.Logger {
  return logger.child({
    requestId: req.requestId,
    storeId: req.store?.id,
  });
}

// ─── How to use the logger across the app ────────────────────────────────────
//
// In any file, import the logger:
//   import { logger } from '../middleware/logger'
//
// Log levels (use the right one):
//   logger.error('Payment failed', { error: err.message, orderId })  // something broke
//   logger.warn('Stock below threshold', { productId, stock })        // worth attention
//   logger.info('Order created', { orderId, total })                  // normal event
//   logger.http('GET /products 200 - 12ms')                          // HTTP logs (Morgan)
//   logger.debug('Cache miss for key', { key })                       // dev only, verbose
//
// In controllers where you have req available, use the child logger:
//   const log = createRequestLogger(req)
//   log.info('Order created', { orderId })  // auto-includes requestId + storeId
//
// NEVER use:
//   console.log()    → unstructured, no levels, not searchable in production
//   console.error()  → same problem
