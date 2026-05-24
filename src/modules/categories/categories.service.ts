import slugify from "slugify";
import { prisma } from "../../config/db";
import { cache } from "../../config/redis";
import { conflict, forbidden, notFound } from "../../utils/appError";
import { logger } from "../../middlewares/logger";
import type {
  createCategoryInput,
  updateCategoryInput,
} from "./categories.schema";

// cahce key for a stored full category list
const categoriesCacheKey = (storeId: string) => `categories:${storeId}`;

// generate  a unque slug within the store
async function generateUniqueCategorySlug(
  name: string,
  storeId: string,
): Promise<string> {
  const base = slugify(name, { lower: true, strict: true });
  let existing = await prisma.category.findUnique({
    where: { storeId_slug: { storeId, slug: base } },
  });
  if (!existing) return base;

  const suffix = Math.random().toString(36).substring(2, 6);
  return `${base}-${suffix}`;
}

export const CategoryService = {
  // Create category
  async create(input: createCategoryInput, storeId: string) {
    // Validate parentId belongs to this store — prevents cross-tenant
    // parent assignments
    if (input.parentId) {
      const parent = await prisma.category.findFirst({
        where: {
          id: input.parentId,
          storeId,
        },
      });
      if (!parent) throw notFound("Parent category not found in the store");
    }
    const slug = await generateUniqueCategorySlug(input.name, storeId);
    const category = await prisma.category.create({
      data: {
        name: input.name,
        image: input.image,
        slug,
        storeId,
        parentId: input.parentId ?? null,
      },
    });

    // invalidate the categories list cache for this store
    await cache.del(categoriesCacheKey(storeId));
    logger.info("Category created successfully", {
      categoryId: category.id,
      storeId,
    });
    return category;
  },

  async list(storeId: string) {
    const cacheKey = categoriesCacheKey(storeId);
    const cached = await cache.get<object[]>(cacheKey);
    if (cached) return cached;

    const categories = await prisma.category.findMany({
      where: { storeId },
      select: {
        id: true,
        name: true,
        image: true,
        slug: true,
        parentId: true,
        children: true,
        createdAt: true,
        _count: {
          select: { children: true, products: true },
        },
      },
      orderBy: { name: "asc" },
    });
    await cache.set(cacheKey, categories, 1800);
    return categories;
  },

  async update(
    input: updateCategoryInput,
    storeId: string,
    categoryId: string,
  ) {
    // check if category exists in the store
    const existing = await prisma.category.findFirst({
      where: {
        id: categoryId,
        storeId,
      },
    });
    if (!existing) throw notFound("Category not found");
    // prevent a category from being its own parent
    if (input.parentId === categoryId)
      throw forbidden("A category cannot be its own parent");
    // validate parentId belongs to this store if provided
    if (input.parentId) {
      const parent = await prisma.category.findFirst({
        where: {
          id: input.parentId,
          storeId,
        },
      });
      if (!parent) throw notFound("Parent category not found in the store");
    }

    // if name is being updated, generate a new unique slug
    let slug: string | undefined = undefined;
    if (input.name) {
      slug = await generateUniqueCategorySlug(input.name, storeId);
    }

    const updatedCategory = await prisma.category.update({
      where: {
        id: categoryId,
      },
      data: {
        ...(input.name && { name: input.name }),
        ...(input.image !== undefined && { image: input.image }),
        ...(slug && { slug }),
        ...(input.parentId !== undefined && { parentId: input.parentId }),
      },
    });

    // invalidate the categories list cache for this store
    await cache.del(categoriesCacheKey(storeId));
    logger.info("Category updated successfully", {
      categoryId: updatedCategory.id,
      storeId,
    });
    return updatedCategory;
  },

  // ── Delete category ────────────────────────────────────────────────────────
  // Cannot delete a category that has products assigned to it.
  // Cannot delete a category that has child categories.
  // These guards prevent orphaned data.
  async delete(categoryId: string, storeId: string) {
    const category = await prisma.category.findFirst({
      where: { id: categoryId, storeId },
      include: {
        _count: { select: { products: true, children: true } },
      },
    });
    if (!category) throw notFound("Category not found");
    if (category._count.children > 0) {
      throw conflict(
        `Cannot delete — this category has ${category._count.children} sub-category(s). Delete them first.`,
      );
    }
    if (category._count.products > 0) {
      throw conflict(
        `Cannot delete — ${category._count.products} product(s) are assigned to this category. Reassign them first.`,
      );
    }
    await prisma.category.delete({ where: { id: categoryId } });
    await cache.del(categoriesCacheKey(storeId));
    logger.info("Category deleted successfully", { categoryId, storeId });
  },
};
