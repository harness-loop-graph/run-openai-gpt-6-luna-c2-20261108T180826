import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import * as express from "express";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { ErrorEnvelopeFilter } from "./common/error.filter";
import { RequestValidationInterceptor } from "./common/request-validation.interceptor";
import { RateLimitService } from "./common/rate-limit";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.use(express.urlencoded({ extended: false }));
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      errorHttpStatusCode: 422,
    }),
  );
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  app.useGlobalInterceptors(
    new RequestValidationInterceptor(app.get(RateLimitService)),
  );
  app.enableCors({ origin: "http://localhost:8080", credentials: true });
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
