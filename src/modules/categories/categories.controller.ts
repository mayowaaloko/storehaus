import type { Request, Response } from "express";
import { CategoryService } from "./categories.service";
import { created, success } from "../../utils/response";

export const categoryController = {
  async create(req: Request, res: Response): Promise<void> {
    const category = await CategoryService.create(req.body, req.store!.id);
    created(res, { category }, "Category created");
  },

  async list(req: Request, res: Response): Promise<void> {
    const categories = await CategoryService.list(req.store!.id);
    success(res, { categories }, "Categories retrieved successfully");
  },

  async update(req: Request, res: Response): Promise<void> {
    const categoryId = Array.isArray(req.params.categoryId)
      ? req.params.categoryId[0]
      : req.params.categoryId;
    const category = await CategoryService.update(
      req.body,
      req.store!.id,
      categoryId,
    );
    success(res, { category }, "Category updated successfully");
  },
  async delete(req: Request, res: Response): Promise<void> {
    const categoryId = Array.isArray(req.params.categoryId)
      ? req.params.categoryId[0]
      : req.params.categoryId;
    await CategoryService.delete(categoryId, req.store!.id);
    success(res, null, "Category deleted successfully");
  },
};
