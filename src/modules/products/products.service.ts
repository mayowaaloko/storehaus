import slugify from "slugify";
import { prisma } from "../../config/db";
import type { CreateProductInput } from "./products.schema";
import { notFound } from "../../utils/appError";
import { cache } from "../../config/redis";
import { logger } from "../../middlewares/logger";

const productCacheKey = (storeId: String, productId: string) =>
  `product:${storeId}:${productId}`;
const productListCacheKey = (storeId: String, query: string) =>
  `products:${storeId}:list:${query}`;

// ─── Slug generator ───────────────────────────────────────────────────────────

async function generateUniqueProductSlug(
  name: string,
  storeId: string,
): Promise<string> {
  const base = slugify(name, { lower: true, strict: true });

  const existing = await prisma.product.findUnique({
    where: { storeId_slug: { storeId, slug: base } },
  });
  if (!existing) return base;

  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
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
        ...input,
        slug,
        storeId,
      },
      include: {
        category: { select: { id: true, name: true, slug: true } },
      },
    });
    // Invalidate product listing cache for this store
    await cache.delByPrefix(`products:${storeId}:list:`);
    logger.info(`Created product ${(product.id, storeId)}`);
    return product;
  },
};
