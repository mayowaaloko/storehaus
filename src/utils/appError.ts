// src/utils/appError.ts

class AppError extends Error {
  public statusCode: number;
  public status: string;
  public isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode >= 500 ? "error" : "fail";
    this.isOperational = true; // errors you throw manually are operational
    Error.captureStackTrace(this, this.constructor);
  }
}

export default AppError;
