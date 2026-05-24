import { z } from "zod";

// ─── Place order ──────────────────────────────────────────────────────────────
// Customer submits a list of items they want to buy.
// Each item needs a productId and a quantity.
// addressId is optional — store might not require delivery address.

export const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.cuid2("Invalid product ID"),
        quantity: z
          .number()
          .int("Quantity must be a whole number")
          .positive("Quantity must be at least 1")
          .max(100, "Maximum quantity per item is 100"),
      }),
    )
    .min(1, "Order must have at least one item"),
  addressId: z.cuid2("Invalid address ID").optional(),
  notes: z.string().max(500).optional(),
});

// ─── Update order status ──────────────────────────────────────────────────────
// Only merchants can update order status.
// The service enforces valid state machine transitions.

export const updateOrderStatusSchema = z.object({
  status: z.enum(
    ["CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"],
    { error: "Invalid order status" },
  ),
  // Optional note explaining the status change e.g. tracking number
  note: z.string().max(300).optional(),
});

// ─── Order list query ─────────────────────────────────────────────────────────

export const orderQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z
    .enum([
      "PENDING",
      "CONFIRMED",
      "PROCESSING",
      "SHIPPED",
      "DELIVERED",
      "CANCELLED",
      "REFUNDED",
    ])
    .optional(),
  paymentStatus: z
    .enum(["UNPAID", "PAID", "PARTIALLY_PAID", "REFUNDED"])
    .optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
export type OrderQueryInput = z.infer<typeof orderQuerySchema>;
