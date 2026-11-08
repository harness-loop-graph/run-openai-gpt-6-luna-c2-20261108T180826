import { Module } from "@nestjs/common";
import { ApiController } from "./api.controller";
import { ApiService } from "./api.service";
import { RateLimitService } from "./common/rate-limit";

@Module({
  controllers: [ApiController],
  providers: [ApiService, RateLimitService],
})
export class AppModule {}
