// validate.ts
import type { Request, Response, NextFunction } from "express";
import { z, type ZodType } from "zod";

export const validate =
  (schema: ZodType) => (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const flatErrors = z.flattenError(result.error);

      // Return the actual field errors so you can see what's wrong
      return res.status(400).json({
        status: "error",
        message: "Validation failed",
        errors: flatErrors.fieldErrors,
      });
    }

    req.body = result.data; // replace body with validated + coerced data
    next();
  };
