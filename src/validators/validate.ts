import type { Request, Response, NextFunction } from "express";

import { z, type ZodType } from "zod";
import { AppError, badRequest } from "../utils/appError";
export const validate =
  (schema: ZodType) => (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const flatErrors = z.flattenError(result.error);
      return next(badRequest("Invalid input data"));
    }
    next();
  };
