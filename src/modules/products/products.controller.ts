import { success, created, paginated } from "../../utils/response";
import {
  createProductSchema,
  productQuerySchema,
  updateProductSchema,
} from "./products.schema";
import { ProductService } from "./products.service";
import type { Request, Response } from "express";

function getParamId(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

export const ProductController = {
  async create(req: Request, res: Response): Promise<void> {
    const input = createProductSchema.parse(req.body);
    const product = await ProductService.create(input, req.store!.id);
    created(res, { product }, "Product created");
  },
  async list(req: Request, res: Response): Promise<void> {
    //Parse+validate query params
    const query = productQuerySchema.parse({
      page: req.query.page,
      limit: req.query.limit,
      categoryId: req.query.categoryId,
      search: req.query.search,
      featured: req.query.featured,
      sortBy: req.query.sortBy,
      sortOrder: req.query.sortOrder,
    });
    //   isMerchant =true means they see unpublished products too
    const isMerchant = req.userType === "user";
    const { products, pagination } = await ProductService.list(
      req.store!.id,
      query,
      isMerchant,
    );
    paginated(res, products, pagination);
  },

  async getOne(req: Request, res: Response): Promise<void> {
    const productId = getParamId(req, "productId");
    const isMerchant = req.userType === "user";
    const product = await ProductService.getOne(
      productId,
      req.store!.id,
      isMerchant,
    );

    success(res, { product }, "Product retrieved");
  },
  async update(req: Request, res: Response): Promise<void> {
    const productId = getParamId(req, "productId");
    const input = updateProductSchema.parse(req.body);
    const product = await ProductService.update(
      productId,
      req.store!.id,
      input,
    );
    success(res, { product }, "Product updated");
  },

  async togglePublish(req: Request, res: Response): Promise<void> {
    const productId = getParamId(req, "productId");
    const product = await ProductService.togglePublish(
      productId,
      req.store!.id,
    );
    success(
      res,
      { product },
      product.published ? "Product published" : "Product unpublished",
    );
  },

  async delete(req: Request, res: Response): Promise<void> {
    const productId = getParamId(req, "productId");
    await ProductService.delete(productId, req.store!.id);
    success(res, null, "Product deleted");
  },
};
