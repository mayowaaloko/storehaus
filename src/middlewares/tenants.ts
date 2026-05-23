import type { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db";
import { cache } from "../config/redis";
import { catchAsync } from "../utils/catchAsync";
import { forbidden, notFound } from "../utils/appError";

export const tenantMiddleware = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // get the slug from the url params
    const { slug } = req.params as { slug: string };
    if (!slug) {
      return next(
        forbidden("You do not have permission to perform this action"),
      );
    }
    // check redis
    const cacheKey = `store:${slug}`;
    const cached = await cache.get<{
      id: string;
      active: boolean;
      ownerId: string;
    }>(cacheKey);
    if (cached) {
      req.store = cached;
      return next();
    }
    // not in cache? - check db
    const store = await prisma.store.findUnique({
      where: { slug },
      select: { id: true, active: true, ownerId: true },
    });
    if (!store) return next(notFound("Store not found"));
    if (!store.active) return next(forbidden("Store is not active"));
    // cache it for 1 hour
    await cache.set(cacheKey, store, 3600);
    req.store = store;
    next();
  },
);
