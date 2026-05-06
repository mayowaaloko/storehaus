import type { Response } from "express";

export const success = (
  res: Response,
  data: unknown,
  message = "Success",
  statusCode = 200,
) => {
  return res.status(statusCode).json({
    status: "success",
    message,
    data,
  });
};

export const created = (res: Response, data: unknown, message = "Created") => {
  return success(res, data, message, 201);
};

export const paginated = (
  res: Response,
  data: unknown,
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  },
) => {
  return res.status(200).json({
    status: "success",
    data,
    pagination,
  });
};
