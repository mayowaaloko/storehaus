import { z } from "zod";

export const createCategorySchema = z.object({
  name: z
    .string({ error: "Category name is required" })
    .min(2, { error: "Category name must be at least 2 characters long" })
    .max(50, { error: "Category name must be less than 50 characters long" }),

  image: z.url("Invalid image URL").optional(),
  parentId: z.cuid2({ message: "Invalid parent category ID" }).optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(2).max(100).optional(),
  image: z.url().optional(),
  parentId: z.cuid2().nullable().optional(),
});

export type createCategoryInput = z.infer<typeof createCategorySchema>;

export type updateCategoryInput = z.infer<typeof updateCategorySchema>;
