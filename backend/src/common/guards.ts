import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ApiService } from "../api.service";

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly api: ApiService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: { authorization?: string } }>();
    await this.api.user(request.headers.authorization);
    return true;
  }
}
