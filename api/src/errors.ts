import type { NextFunction, Request, Response } from "express";
import multer from "multer";

/** An error carrying an intended HTTP status. Thrown from route handlers. */
export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new ApiError(400, msg, details);
export const notFound = (msg: string) => new ApiError(404, msg);

/**
 * Wrap an async route handler so a rejected promise reaches Express's error
 * middleware instead of hanging the request. (Express 4 does not await handlers.)
 */
export function wrap(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/** Terminal error middleware. Must have 4 args for Express to treat it as such. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  // multer raises this for oversized uploads, wrong field name, too many
  // files, etc. — all client mistakes, so all 400s. err.message is already
  // clear ("File too large", "Unexpected field", ...).
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error("[api] unhandled error:", err);
  res.status(500).json({ error: "internal server error" });
}
