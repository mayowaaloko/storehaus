import slugify from "slugify";
import { prisma } from "../../config/db";
import type { CreateStoreInput, UpdateStoreInput } from "./stores.schma";
import { logger } from "../../middlewares/logger";
import { cache } from "../../config/redis";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../../utils/appError";

async function generateUniqueSlug(name: string): Promise<string> {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw badRequest("Store name is required and must be a non-empty string");
  }
  // initialize base slug
  const baseSlug = slugify(name, { lower: true, strict: true });

  // check if base slug is available
  let slug = baseSlug;
  let existing = await prisma.store.findUnique({ where: { slug: slug } });
  if (!existing) return slug;

  // slug taken-append random suffix and retry up to 5
  for (let i = 1; i <= 5; i++) {
    const suffix = Math.random().toString(36).substring(2, 8);
    slug = `${baseSlug}-${suffix}`;
    const existing = await prisma.store.findUnique({
      where: { slug: slug },
    });
    if (!existing) return slug;
  }
  // final fallback with timestamp
  slug = `${baseSlug}-${Date.now()}`;
  // double check
  existing = await prisma.store.findUnique({ where: { slug: slug } });
  if (!existing) {
    logger.error("Failed to generate unique slug even with  timestamp", {
      originalName: name,
      baseSlug,
    });
    throw conflict(
      "Could not generate a unique slug. Please try a different store name",
    );
  }
  return slug;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const storeService = {
  // ── Create store ───────────────────────────────────────────────────────────
  // Merchant creates a store. Slug is auto-generated from the name.
  // Merchant is set as the owner via ownerId from their JWT
  async create(input: CreateStoreInput, ownerId: string) {
    if (!input?.name) {
      throw badRequest("Store name is required");
    }
    // generate unique slug from the store name
    const slug = await generateUniqueSlug(input.name);

    // create the store
    const store = await prisma.store.create({
      data: {
        name: input.name,
        slug,
        description: input.description,
        currency: input.currency,
        ownerId,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        currency: true,
        plan: true,
        active: true,
        createdAt: true,
      },
    });
    logger.info("Store created successfully", { storeId: store.id });
    return store;
  },

  // ── List merchant's stores ─────────────────────────────────────────────────
  // Returns all stores owned by this merchant.
  // A merchant can own multiple stores.
  async listByOwner(ownerId: string) {
    const stores = await prisma.store.findMany({
      where: {
        ownerId,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        currency: true,
        plan: true,
        active: true,
        createdAt: true,
        _count: {
          select: {
            products: true,
            orders: true,
            customers: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    return stores;
  },
  // ── Get single store ───────────────────────────────────────────────────────
  // Public info — anyone can view basic store details.
  // The tenant middleware already confirmed the store exists and is active.
  async getBySlug(slug: string) {
    //   check redis first
    const cacheKey = `store:public:${slug}`;
    const cached = await cache.get<object>(cacheKey);
    if (cached) return cached;

    const store = await prisma.store.findUnique({
      where: {
        slug,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        logo: true,
        currency: true,
        plan: true,
        active: true,
        createdAt: true,
      },
    });
    if (!store) throw notFound("Store not found or is inactive");
    await cache.set(cacheKey, store, 3600);
    return store;
  },
  // ── Update store ───────────────────────────────────────────────────────────
  // Only the owner can update their store.
  // ownerId guard is enforced here AND in requireStoreOwner middleware.
  async update(storeId: string, ownerId: string, input: UpdateStoreInput) {
    //   confirm ownership before update
    const store = await prisma.store.findFirst({
      where: { id: storeId, ownerId: ownerId },
    });
    if (!store)
      throw forbidden("Access denied. You do not have access to this store");
    const updated = await prisma.store.update({
      where: { id: storeId },
      data: {
        ...(input.name && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.logo && { logo: input.logo }),
        ...(input.currency && { currency: input.currency }),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        logo: true,
        currency: true,
        plan: true,
        active: true,
        createdAt: true,
      },
    });
    //   invalidate all caches for this store
    await cache.del(`store:${store.slug}`); //tenant middleware cache
    await cache.del(`store:public:${store.slug}`); //public store cache

    logger.info("Store updated successfully", { storeId: store.id, ownerId });
    return updated;
  },

  // ── Deactivate store ───────────────────────────────────────────────────────
  // Soft delete — sets active = false.
  // The tenant middleware will return 403 for any future requests to this store.
  // We never hard delete stores — orders and products reference them.

  async deactivate(storeId: string, ownerId: string) {
    const store = await prisma.store.findFirst({
      where: { id: storeId, ownerId: ownerId },
    });
    if (!store)
      throw forbidden("Access denied. You do not have access to this store");
    if (!store.active) throw forbidden("Store is already deactivated");

    await prisma.store.update({
      where: { id: storeId },
      data: { active: false },
    });

    //   invalidate all caches for this store
    await cache.del(`store:${store.slug}`);
    await cache.del(`store:public:${store.slug}`);

    logger.info("Store deactivated successfully", { storeId, ownerId });
  },
};
