import { z } from "zod";

export const createStoreSchema = z.object({
  name: z
    .string({ error: "Store name is required" })
    .min(2, { error: "Store name must be at least 2 characters" })
    .max(100, { error: "Store name must be at most 100 character" }),
  description: z
    .string({ error: "Store description is required" })
    .max(500, { error: "Store description must be at most 500 character" })
    .optional(),
  currency: z
    .string({ error: "currency is required" })
    .length(3, { error: "currency must be 3 characters" })
    .default("NGN"),
});

export const updateStoreSchema = z.object({
  name: z
    .string({ error: "Store name is required" })
    .min(2, {
      error: "Store name must be at least 2 characters",
    })
    .max(100, { error: "Store name must be at most 100 character" })
    .optional(),
  description: z
    .string({ error: "Store description is required" })
    .max(500, { error: "Store description must be at most 500 character" })
    .optional(),
  logo: z.url().optional(),
  currency: z.string().length(3).default("NGN").optional(),
});

export type CreateStoreInput = z.infer<typeof createStoreSchema>;
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;
