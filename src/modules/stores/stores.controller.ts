import type { Request, Response } from "express";
import { storeService } from "./stores.service";
import { created, success } from "../../utils/response";
import { unauthorized } from "../../utils/appError";

export const StoreController = {
  // create
  async create(req: Request, res: Response) {
    const ownerId = req.user?.id;
    if (!ownerId) {
      throw unauthorized("Authentication required");
    }
    const store = await storeService.create(req.body, ownerId);
    created(res, { store }, "Store created successfully");
  },

  // list
  async list(req: Request, res: Response) {
    const ownerId = req.user?.id;
    if (!ownerId) {
      throw unauthorized("Authentication required");
    }
    const stores = await storeService.listByOwner(ownerId);
    success(res, { stores }, "Stores retrieved");
  },

  //   getOne
  async getOne(req: Request, res: Response) {
    const { slug } = req.params as { slug: string };
    const store = await storeService.getBySlug(slug);
    success(res, { store }, "Store retrieved");
  },

  //   update
  async update(req: Request, res: Response) {
    const ownerId = req.user?.id;
    if (!ownerId) {
      throw unauthorized("Authentication required");
    }
    const storeId = req.store!.id;
    const store = await storeService.update(storeId, ownerId, req.body);
    success(res, { store }, "Store updated");
  },

  //   deactivate
  async deactivate(req: Request, res: Response) {
    const ownerId = req.user?.id;
    if (!ownerId) {
      throw unauthorized("Authentication required");
    }
    const storeId = req.store!.id;
    await storeService.deactivate(storeId, ownerId);
    success(res, null, "Store deactivated successfully");
  },
};
