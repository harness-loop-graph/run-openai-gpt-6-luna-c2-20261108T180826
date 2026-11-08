import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { Request, Response } from "express";

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const custom = exception as { status?: number; message?: string };
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : (custom.status ?? 500);
    const message =
      status >= 500
        ? "Internal server error"
        : (custom.message ?? "Request failed");
    response.status(status).json({
      error: {
        code:
          status === 422
            ? "VALIDATION_ERROR"
            : status === 401
              ? "UNAUTHORIZED"
              : status === 403
                ? "FORBIDDEN"
                : status === 404
                  ? "NOT_FOUND"
                  : status === 409
                    ? "CONFLICT"
                    : status === 413
                      ? "PAYLOAD_TOO_LARGE"
                      : status === 415
                        ? "UNSUPPORTED_MEDIA_TYPE"
                        : "REQUEST_ERROR",
        message,
      },
      path: request.path,
    });
  }
}
