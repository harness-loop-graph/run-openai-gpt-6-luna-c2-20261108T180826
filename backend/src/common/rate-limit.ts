import { Injectable } from "@nestjs/common";
import { Request } from "express";
import { randomBytes } from "crypto";

@Injectable()
export class RateLimitService {
  private readonly requests = new Map<string, number[]>();

  consume(key: string, limit: number): number | undefined {
    const now = Date.now();
    const active = (this.requests.get(key) ?? []).filter(
      (time) => now - time < 60000,
    );
    if (active.length >= limit)
      return Math.max(1, Math.ceil((60000 - (now - active[0])) / 1000));
    active.push(now);
    this.requests.set(key, active);
    return undefined;
  }
}

export function clientIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

export function opaqueRequestId(): string {
  return randomBytes(12).toString("hex");
}
