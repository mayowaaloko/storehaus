import slugify from "slugify";
import { prisma } from "../../config/db";
import type {
  CreateProductInput,
  ProductQueryInput,
  UpdateProductInput,
} from "./products.schema";
import { badRequest, conflict, notFound } from "../../utils/appError";
import { cache } from "../../config/redis";
import { logger } from "../../middlewares/logger";
import { getPaginationArgs, getPaginationMeta } from "../../utils/pagination";
import { Prisma } from "../../generated/prisma";

type ProductListResult = {
  products: any[];
  pagination: ReturnType<typeof getPaginationMeta>;
};

// ─── Cache key helpers ────────────────────────────────────────────────────────
const productCacheKey = (storeId: string, productId: string) =>
  `product:${storeId}:${productId}`;
const productListCacheKey = (storeId: String, query: string) =>
  `products:${storeId}:list:${query}`;

// ─── Slug generator ───────────────────────────────────────────────────────────

async function generateUniqueProductSlug(
  name: string,
  storeId: string,
): Promise<string> {
  const base = slugify(name, { lower: true, strict: true });

  let existing = await prisma.product.findUnique({
    where: { storeId_slug: { storeId, slug: base } },
  });
  if (!existing) return base;

  for (let i = 1; i <= 5; i++) {
    const suffix = Math.random().toString(36).slice(2, 6);
    const slug = `${base}-${suffix}`;
    existing = await prisma.product.findUnique({
      where: { storeId_slug: { storeId, slug } },
    });
    if (!existing) return slug;
  }

  return `${base}-${Date.now()}`;
}

export const ProductService = {
  // create product
  async create(input: CreateProductInput, storeId: string) {
    //validate categoryId belongs to this store
    if (input.categoryId) {
      const category = await prisma.category.findFirst({
        where: { id: input.categoryId, storeId },
      });
      if (!category) throw notFound("Category not found in this store");
    }
    const slug = await generateUniqueProductSlug(input.name, storeId);
    const product = await prisma.product.create({
      data: {
        name: input.name,
        slug,
        description: input.description,
        price: input.price,
        comparePrice: input.comparePrice ?? null,
        sku: input.sku,
        barcode: input.barcode,
        images: input.images,
        tags: input.tags,
        weight: input.weight,
        categoryId: input.categoryId ?? null,
        published: input.published,
        featured: input.featured,
        storeId,
      },
      include: {
        category: { select: { id: true, name: true, slug: true } },
      },
    });
    // Invalidate product listing cache for this store
    await cache.delByPrefix(`products:${storeId}:list:`);
    logger.info("Product created", { productId: product.id, storeId });
    return product;
  },

  // ── List products ──────────────────────────────────────────────────────────
  // Public: only published products
  // Merchant: all products including unpublished
  // Supports: pagination, search, category filter, sort
  async list(
    storeId: string,
    query: ProductQueryInput,
    isMerchant = false,
  ): Promise<ProductListResult> {
    const { page, limit, categoryId, search, featured, sortBy, sortOrder } =
      query;
    const allowedSortFields = [
      "name",
      "price",
      "createdAt",
      "updatedAt",
    ] as const;
    if (
      !allowedSortFields.includes(sortBy as (typeof allowedSortFields)[number])
    ) {
      throw badRequest(
        `Invalid sortBy. Must be one of ${allowedSortFields.join(", ")}`,
      );
    }
    const cacheKey = productListCacheKey(
      storeId,
      JSON.stringify({
        page,
        limit,
        categoryId,
        search,
        featured,
        sortBy,
        sortOrder,
        isMerchant,
      }),
    );
    if (!isMerchant) {
      const cached = await cache.get<ProductListResult>(cacheKey);
      if (cached) return cached;
    }
    const where = {
      storeId,
      ...(!isMerchant && { published: true }),
      ...(categoryId && { categoryId }),
      ...(featured === "true" && { featured: true }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" as const } },
          { description: { contains: search, mode: "insensitive" as const } },
          { tags: { has: search } },
        ],
      }),
    };
    const { skip, take } = getPaginationArgs(page, limit);
    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          price: true,
          comparePrice: true,
          images: true,
          published: true,
          featured: true,
          tags: true,
          createdAt: true,
          category: { select: { id: true, name: true, slug: true } },
          _count: { select: { variants: true } },
        },
        orderBy: { [sortBy]: sortOrder },
        skip,
        take,
      }),
      prisma.product.count({ where }),
    ]);

    const pagination = getPaginationMeta(total, page, limit);
    const result: ProductListResult = { products, pagination };

    if (!isMerchant) {
      await cache.set(cacheKey, result, 300);
    }
    return result;
  },

  // ── Get single product ─────────────────────────────────────────────────────

  async getOne(productId: string, storeId: string, isMerchant = false) {
    const cacheKey = productCacheKey(storeId, productId);
    if (!isMerchant) {
      const cached = await cache.get<object>(cacheKey);
      if (cached) return cached;
    }
    const product = await prisma.product.findFirst({
      where: {
        id: productId,
        storeId,
        ...(!isMerchant && { published: true }),
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        variants: {
          where: { active: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!product) throw notFound("Product not found");
    if (!isMerchant) {
      await cache.set(cacheKey, product, 600);
    }
    return product;
  },

  // ── Update product ─────────────────────────────────────────────────────
  async update(productId: string, storeId: string, input: UpdateProductInput) {
    const existing = await prisma.product.findFirst({
      where: { id: productId, storeId },
    });
    if (!existing) throw notFound("Product not found");
    if (input.categoryId) {
      const category = await prisma.category.findFirst({
        where: { id: input.categoryId, storeId },
      });
      if (!category) throw notFound("Category not found in this store");
    }
    const newPrice =
      input.price !== undefined ? input.price : Number(existing.price);
    const newComparePrice =
      input.comparePrice !== undefined
        ? input.comparePrice
        : existing.comparePrice
          ? Number(existing.comparePrice)
          : null;

    if (
      newComparePrice !== null &&
      newComparePrice !== undefined &&
      newComparePrice <= newPrice
    ) {
      throw conflict("Compare price must be greater than the actual price");
    }
    const updated = await prisma.product.update({
      where: { id: productId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.price !== undefined && { price: input.price }),
        ...(input.comparePrice !== undefined && {
          comparePrice: input.comparePrice,
        }),
        ...(input.sku !== undefined && { sku: input.sku }),
        ...(input.barcode !== undefined && { barcode: input.barcode }),
        ...(input.images !== undefined && { images: input.images }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(input.weight !== undefined && { weight: input.weight }),
        ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
        ...(input.published !== undefined && { published: input.published }),
        ...(input.featured !== undefined && { featured: input.featured }),
      },
      include: {
        category: { select: { id: true, name: true, slug: true } },
      },
    });

    await cache.del(productCacheKey(storeId, productId));
    await cache.delByPrefix(`products:${storeId}:list:`);

    logger.info("Product updated", { productId, storeId });

    return updated;
  },

  //   toggle publish
  async togglePublish(productId: string, storeId: string) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId },
    });
    if (!product) throw notFound("Product not found");

    const updated = await prisma.product.update({
      where: { id: productId },
      data: { published: !product.published },
      select: { id: true, published: true, name: true },
    });

    await cache.del(productCacheKey(storeId, productId));
    await cache.delByPrefix(`products:${storeId}:list:`);

    logger.info(`Product ${updated.published ? "published" : "unpublished"}`, {
      productId,
      storeId,
    });

    return updated;
  },

  // ── Delete product ─────────────────────────────────────────────────────────
  // Soft delete — sets published = false.
  // We don't hard delete because orders reference products historically.
  // The product disappears from public listings immediately.
  async delete(productId: string, storeId: string) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId },
      include: { _count: { select: { orderItems: true } } },
    });

    if (!product) throw notFound("Product not found");

    if (product._count.orderItems > 0) {
      // Has order history — soft delete only
      await prisma.product.update({
        where: { id: productId },
        data: { published: false },
      });
      logger.info("Product soft deleted (has order history)", {
        productId,
        storeId,
      });
    } else {
      try {
        // No order history — safe to hard delete
        await prisma.product.delete({ where: { id: productId } });
        logger.info("Product hard deleted", { productId, storeId });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2003"
        ) {
          await prisma.product.update({
            where: { id: productId },
            data: { published: false },
          });
          logger.info("Product soft deleted (has related data)", {
            productId,
            storeId,
          });
        } else {
          throw err;
        }
      }
    }

    await cache.del(productCacheKey(storeId, productId));
    await cache.delByPrefix(`products:${storeId}:list:`);
  },
};
