export class AppError extends Error {
  public readonly statusCode: number;
  public readonly status: string;
  public isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode >= 500 ? "error" : "fail";
    this.isOperational = true; // errors you throw manually are operational
    Error.captureStackTrace(this, this.constructor);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export const badRequest = (msg: string) => new AppError(msg, 400);
export const unauthorized = (msg: string) => new AppError(msg, 401);
export const forbidden = (msg: string) => new AppError(msg, 403);
export const notFound = (msg: string) => new AppError(msg, 404);
export const conflict = (msg: string) => new AppError(msg, 409);
export const locked = (msg: string) => new AppError(msg, 423);
export const tooManyRequests = (msg: string) => new AppError(msg, 429);
export const serverError = (msg: string) => new AppError(msg, 500);
