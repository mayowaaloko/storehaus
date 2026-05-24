import type { Request, Response } from "express";
import { OrderService } from "./orders.services";
import { success, created, paginated } from "../../utils/response";
import {
  orderQuerySchema,
  createOrderSchema,
  updateOrderStatusSchema,
} from "./orders.schema";

function getParamId(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

function assertViewerType(req: Request): "user" | "customer" {
  const t = req.userType;
  if (t !== "user" && t !== "customer") {
    throw new Error(`Invalid userType: ${t}`);
  }
  return t;
}

export const OrderController = {
  async create(req: Request, res: Response): Promise<void> {
    const customer = req.user as any;
    const store = req.store as any;

    // Idempotency key — client sends this header to prevent duplicate orders
    // e.g. if they double-tap the checkout button or retry after a timeout
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

    const order = await OrderService.create(
      req.body,
      store.id,
      customer.id,
      store.name ?? "Store",
      idempotencyKey,
    );

    created(res, { order }, "Order placed successfully");
  },

  async list(req: Request, res: Response): Promise<void> {
    const viewer = req.user as any;
    const viewerType = assertViewerType(req); //  narrow type safely

    const query = orderQuerySchema.parse({
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status,
      paymentStatus: req.query.paymentStatus,
      sortOrder: req.query.sortOrder,
    });

    const { orders, pagination: meta } = await OrderService.list(
      req.store!.id,
      query,
      viewer.id,
      viewerType,
    );

    paginated(res, orders, meta);
  },

  async getOne(req: Request, res: Response): Promise<void> {
    const viewer = req.user as any;
    const orderId = getParamId(req, "orderId"); //  narrow from params

    const order = await OrderService.getOne(
      orderId,
      req.store!.id,
      viewer.id,
      assertViewerType(req),
    );

    success(res, { order }, "Order retrieved");
  },

  async updateStatus(req: Request, res: Response): Promise<void> {
    const orderId = getParamId(req, "orderId");

    const order = await OrderService.updateStatus(
      orderId,
      req.store!.id,
      req.body,
    );

    success(res, { order }, "Order status updated");
  },

  async cancel(req: Request, res: Response): Promise<void> {
    const customer = req.user as any;
    const orderId = getParamId(req, "orderId");

    await OrderService.cancel(orderId, req.store!.id, customer.id);

    success(res, null, "Order cancelled successfully");
  },
};
