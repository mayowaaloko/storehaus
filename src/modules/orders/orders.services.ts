// ─── Order state machine ──────────────────────────────────────────────────────
//
// Defines which transitions are legal.
// A merchant cannot jump from PENDING to DELIVERED.
// CANCELLED and REFUNDED are terminal — no transitions out.
//
//   PENDING → CONFIRMED → PROCESSING → SHIPPED → DELIVERED
//      ↓          ↓            ↓
//   CANCELLED CANCELLED   CANCELLED
//   DELIVERED → REFUNDED

import { prisma } from "../../config/db";
import { cache } from "../../config/redis";
import { logger } from "../../middlewares/logger";
import { badRequest, notFound } from "../../utils/appError";
import { generateOrderNumber } from "../../utils/orderNumber";
import { getPaginationArgs, getPaginationMeta } from "../../utils/pagination";
import type {
  CreateOrderInput,
  OrderQueryInput,
  UpdateOrderStatusInput,
} from "./orders.schema";

const VALID_TRANSITION: Record<string, string[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: ["REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
};

function assertValidTransition(current: string, next: string): void {
  const allowed = VALID_TRANSITION[current] ?? [];
  if (!allowed.includes(next)) {
    throw badRequest(
      `Cannot transition order from ${current} to ${next}.` +
        `Allowed transitions: ${allowed.join(", ") || "none"}`,
    );
  }
}

export const OrderService = {
  // ── Create order ───────────────────────────────────────────────────────────
  //
  // This is the most complex operation in the system.
  // Everything runs inside a Prisma interactive transaction so that:
  //   - Stock is checked and decremented atomically
  //   - If any item is out of stock, the entire order is rolled back
  //   - Two customers cannot buy the last item simultaneously
  //
  // Idempotency: caller passes an idempotency key (from the request header).
  // If the key exists in Redis, return the cached response instead of
  // creating a duplicate order.

  async create(
    input: CreateOrderInput,
    storeId: string,
    customerId: string,
    storeName: string,
    idempotencyKey?: string,
  ) {
    // ── Idempotency check ──────────────────────────────────────────────────
    if (idempotencyKey) {
      const cached = await cache.get<object>(`idempotency:${idempotencyKey}`);
      if (cached) {
        logger.info(` Order creation idempotency key ${idempotencyKey} hit`);
        return cached;
      }
    }

    // ── Validate address belongs to this customer ──────────────────────────
    if (input.addressId) {
      const address = await prisma.address.findFirst({
        where: { id: input.addressId, customerId },
      });
      if (!address)
        throw notFound("Address not found or not owned by customer");
    }

    // ── Run everything in a transaction ────────────────────────────────────
    // prisma.$transaction ensures all operations succeed or all fail together.
    // If stock runs out halfway through, the whole thing rolls back.
    const order = await prisma.$transaction(async (tx) => {
      // 1. Fetch all products in one query — don't query inside a loop
      const productIds = input.items.map((i) => i.productId);
      const products = await tx.product.findMany({
        where: {
          id: { in: productIds },
          storeId, //tenant isolation-only this store's products
          published: true, //cannot order unpublished products
        },
      });

      // 2. Validate all products were found
      if (products.length !== productIds.length) {
        const foundIds = products.map((p) => p.id);
        const missing = productIds.filter((id) => !foundIds.includes(id));
        throw notFound(
          `Products(s) not found or unavailable: ${missing.join(", ")}`,
        );
      }

      // 3. Build a map for quick lookup
      const productMap = new Map(products.map((p) => [p.id, p]));

      // 4. Check stock and build order items
      let subtotal = 0;
      const orderItems: Array<{
        productId: string;
        quantity: number;
        unitPrice: number;
        total: number;
      }> = [];

      for (const item of input.items) {
        const product = productMap.get(item.productId)!;
        const currentStock = product.stock ?? 0; // fallback if no variant

        if (currentStock < item.quantity) {
          throw badRequest(
            `Insufficient stock for "${product.name}". ` +
              `Requested: ${item.quantity}, available: ${currentStock}`,
          );
        }

        const unitPrice = Number(product.price);
        const lineTotal = unitPrice * item.quantity;
        subtotal += lineTotal;

        orderItems.push({
          productId: item.productId,
          quantity: item.quantity,
          unitPrice,
          total: lineTotal,
        });
      }

      // 5. Generate human-readable order number
      const orderNumber = await generateOrderNumber(storeId, storeName);

      // 6. Create the order + items together
      const newOrder = await tx.order.create({
        data: {
          orderNumber,
          storeId,
          customerId,
          addressId: input.addressId ?? null,
          notes: input.notes,
          subtotal,
          total: subtotal, // no shipping/tax yet — add in Phase 7
          currency: "NGN",
          items: {
            create: orderItems,
          },
        },
        include: {
          items: {
            include: {
              product: { select: { id: true, name: true, images: true } },
            },
          },
          address: true,
        },
      });

      // 7. Decrement stock for each product
      // Using updateMany in a loop here because Prisma doesn't support
      // bulk conditional updates (each product has a different quantity)
      for (const item of input.items) {
        const product = productMap.get(item.productId)!;
        const stockBefore = product.stock ?? 0;

        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: item.quantity } },
        });

        // Write inventory log — immutable record of stock change
        await tx.inventoryLog.create({
          data: {
            productId: item.productId,
            storeId,
            changeType: "SALE",
            delta: -item.quantity,
            stockBefore,
            stockAfter: stockBefore - item.quantity,
            reason: orderNumber,
            orderId: newOrder.id,
            performedBy: customerId,
          },
        });
      }

      return newOrder;
    });

    // ── Post-transaction ───────────────────────────────────────────────────
    // Transaction committed — now handle async side effects

    // Invalidate analytics cache — new order changes revenue numbers
    await cache.delByPrefix(`analytics:${storeId}:`);

    // Store idempotency result so duplicate requests return same response
    if (idempotencyKey) {
      await cache.set(`idempotency:${idempotencyKey}`, order, 86400); // 24h
    }

    // TODO Phase 6: publish order.created job to BullMQ
    // await orderQueue.add("order.created", {
    //   orderId: order.id,
    //   storeId,
    //   customerId,
    //   orderNumber: order.orderNumber,
    //   items: input.items,
    // })

    logger.info("Order created", {
      orderId: order.id,
      orderNumber: order.orderNumber,
      storeId,
      customerId,
      total: order.total,
    });

    return order;
  },

  // ── List orders ────────────────────────────────────────────────────────────
  // Merchant sees ALL orders for their store.
  // Customer sees ONLY their own orders.

  async list(
    storeId: string,
    query: OrderQueryInput,
    viewerId: string,
    viewerType: "user" | "customer",
  ) {
    const { page, limit, status, paymentStatus, sortOrder } = query;

    const where = {
      storeId,
      // Customer can only see their own orders — merchant sees all
      ...(viewerType === "customer" && { customerId: viewerId }),
      ...(status && { status }),
      ...(paymentStatus && { paymentStatus }),
    };

    const { skip, take } = getPaginationArgs(page, limit);

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          subtotal: true,
          total: true,
          currency: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { items: true } },
          customer: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
        orderBy: { createdAt: sortOrder },
        skip,
        take,
      }),
      prisma.order.count({ where }),
    ]);

    return { orders, pagination: getPaginationMeta(total, page, limit) };
  },

  // ── Get single order ───────────────────────────────────────────────────────

  async getOne(
    orderId: string,
    storeId: string,
    viewerId: string,
    viewerType: "user" | "customer",
  ) {
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        storeId,
        // Customer can only view their own order
        ...(viewerType === "customer" && { customerId: viewerId }),
      },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, slug: true, images: true },
            },
          },
        },
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneNumber: true,
          },
        },
        address: true,
        payments: {
          select: {
            id: true,
            amount: true,
            status: true,
            provider: true,
            providerRef: true,
            createdAt: true,
          },
        },
      },
    });

    if (!order) throw notFound("Order not found");

    return order;
  },

  // ── Update order status ────────────────────────────────────────────────────
  // Merchant only. Validates state machine transition before updating.

  async updateStatus(
    orderId: string,
    storeId: string,
    input: UpdateOrderStatusInput,
  ) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      include: {
        customer: { select: { email: true } }, // needed for email queue below
      },
    });

    if (!order) throw notFound("Order not found");

    // Enforce state machine — throws if transition is invalid
    assertValidTransition(order.status, input.status);

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { status: input.status },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        updatedAt: true,
      },
    });

    // TODO Phase 6: enqueue email.send for status update notification
    // await emailQueue.add("email.send", {
    //   to: order.customer.email,
    //   template: "order_status_update",
    //   data: { orderNumber: order.orderNumber, status: input.status }
    // })

    logger.info("Order status updated", {
      orderId,
      storeId,
      from: order.status,
      to: input.status,
    });

    return updated;
  },

  // ── Cancel order ───────────────────────────────────────────────────────────
  // Customer can cancel their own PENDING order only.
  // Stock is restored when an order is cancelled.

  async cancel(orderId: string, storeId: string, customerId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId, customerId },
      include: { items: true },
    });

    if (!order) throw notFound("Order not found");
    if (order.status !== "PENDING") {
      throw badRequest(
        "Only PENDING orders can be cancelled. Contact the store for help with other orders.",
      );
    }

    // Restore stock and update order status in one transaction
    await prisma.$transaction(async (tx) => {
      // Restore stock for each item
      for (const item of order.items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { stock: true },
        });
        const stockBefore = product?.stock ?? 0;

        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });

        await tx.inventoryLog.create({
          data: {
            productId: item.productId,
            storeId,
            changeType: "RETURN",
            delta: item.quantity,
            stockBefore, // fetched current stock before restoring
            stockAfter: stockBefore + item.quantity,
            reason: `CANCELLED: ${order.orderNumber}`,
            orderId: order.id,
            performedBy: customerId,
          },
        });
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELLED" },
      });
    });

    await cache.delByPrefix(`analytics:${storeId}:`);

    logger.info("Order cancelled by customer", {
      orderId,
      orderNumber: order.orderNumber,
      customerId,
      storeId,
    });
  },
};
