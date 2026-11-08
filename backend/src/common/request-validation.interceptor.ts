import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Observable } from "rxjs";
import { clientIp, RateLimitService } from "./rate-limit";

const bodyFields: Record<string, string[]> = {
  "POST /auth/login": [
    "email",
    "password",
    "request",
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "state",
  ],
  "POST /auth/token": ["code", "code_verifier", "client_id", "redirect_uri"],
  "POST /auth/token/refresh": ["refresh_token"],
  "POST /auth/revoke": ["token"],
  "POST /appointments": ["professionalId", "slotStart"],
  "POST /appointments/:id/encounter": ["notes", "diagnosis"],
  "POST /admin/users": ["email", "roles"],
  "PATCH /admin/users/:id/roles": ["roles"],
  "PUT /admin/professionals/:id/availability": ["slots"],
};

const queryFields: Record<string, string[]> = {
  "GET /auth/authorize": [
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "state",
  ],
  "GET /availability": ["professionalId", "from", "to"],
  "GET /agenda": ["from", "to"],
  "GET /admin/users": ["page"],
  "GET /admin/audit": ["actor", "action", "from", "to"],
};

@Injectable()
export class RequestValidationInterceptor implements NestInterceptor {
  constructor(private readonly limits: RateLimitService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const method = request.method.toUpperCase();
    const route = request.route?.path;
    if (!route) return next.handle();
    const key = `${method} ${route}`;
    const rejectUnknown = (input: unknown, fields: string[]): void => {
      if (input === undefined || input === null) return;
      if (typeof input !== "object" || Array.isArray(input))
        throw new HttpException("Invalid request body", 422);
      const unknown = Object.keys(input).filter(
        (field) => !fields.includes(field),
      );
      if (unknown.length)
        throw new HttpException("Undeclared request field", 422);
    };
    if (bodyFields[key]) rejectUnknown(request.body, bodyFields[key]);
    if (queryFields[key]) rejectUnknown(request.query, queryFields[key]);
    if (key.startsWith("POST /auth/"))
      this.limit(`auth:${clientIp(request)}`, 5, response);
    if (key === "POST /appointments")
      this.limit(
        `booking:${request.headers.authorization ?? clientIp(request)}`,
        10,
        response,
      );
    return next.handle();
  }

  private limit(key: string, maximum: number, response: Response): void {
    const retry = this.limits.consume(key, maximum);
    if (retry !== undefined) {
      response.setHeader("Retry-After", String(retry));
      throw new HttpException("Too many requests", 429);
    }
  }
}
