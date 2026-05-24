import { z } from "zod";

export const createProductSchema = z
  .object({
    name: z
      .string({ error: "Product name is required" })
      .min(2, "Name must be at least 2 characters")
      .max(200, "Name must be at most 200 characters"),
    description: z.string().max(5000).optional(),
    price: z
      .number({ error: "Price is required" })
      .positive("Price must be greater than 0")
      .multipleOf(0.01, "Price can have at most 2 decimal places"),
    comparePrice: z.number().positive().multipleOf(0.01).optional(),
    sku: z.string().max(100).optional(),
    barcode: z.string().max(100).optional(),
    images: z.array(z.url()).default([]),
    tags: z.array(z.string()).default([]),
    weight: z.number().positive().optional(),
    categoryId: z.cuid2("Invalid category ID").optional(),
    published: z.boolean().default(false),
    featured: z.boolean().default(false),
  })
  .refine((data) => !data.comparePrice || data.comparePrice > data.price, {
    message: "Compare price must be greater than the actual price",
    path: ["comparePrice"],
  });

export const updateProductSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(5000).optional(),
  price: z.number().positive().multipleOf(0.01).optional(),
  comparePrice: z.number().positive().multipleOf(0.01).nullable().optional(),
  sku: z.string().max(100).optional(),
  barcode: z.string().max(100).optional(),
  images: z.array(z.url()).optional(),
  tags: z.array(z.string()).optional(),
  weight: z.number().positive().optional(),
  categoryId: z.cuid2().nullable().optional(),
  published: z.boolean().optional(),
  featured: z.boolean().optional(),
});

export const productQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  categoryId: z.cuid2().optional(),
  search: z.string().optional(),
  featured: z.enum(["true", "false"]).optional(),
  sortBy: z.enum(["createdAt", "price", "name"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ProductQueryInput = z.infer<typeof productQuerySchema>;
