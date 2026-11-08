import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { diskStorage } from "multer";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ApiService } from "./api.service";
import { ErrorEnvelopeFilter } from "./common/error.filter";

@Controller()
export class ApiController {
  constructor(private readonly api: ApiService) {}

  @Get("health")
  health(): object {
    return { status: "ok" };
  }

  @Get("auth/authorize")
  async authorize(
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const login = await this.api.authorize(query);
    response.redirect(302, login);
  }

  @Get("auth/login")
  loginForm(
    @Query("request") request: string,
    @Res() response: Response,
  ): void {
    const authorization = this.api.authorizationRequest(String(request ?? ""));
    const hidden = Object.entries(authorization)
      .map(([name, value]) => {
        const escapedName = name.replace(
          /[&<>"']/g,
          (char) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[char] as string,
        );
        const escapedValue = value.replace(
          /[&<>"']/g,
          (char) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[char] as string,
        );
        return `<input type="hidden" name="${escapedName}" value="${escapedValue}">`;
      })
      .join("");
    const escaped = String(request ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char] as string,
    );
    response
      .type("html")
      .send(
        `<!doctype html><html><body><form method="post" action="/auth/login">${hidden}<input type="hidden" name="request" value="${escaped}"><label>Email<input name="email" type="email" required></label><label>Password<input name="password" type="password" required></label><button type="submit">Sign in</button></form></body></html>`,
      );
  }

  @Post("auth/login")
  async login(
    @Body() body: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const target = await this.api.login(
      body.email,
      body.password,
      body.request,
    );
    response.redirect(302, target);
  }

  @Post("auth/token")
  token(
    @Body()
    body: {
      code: string;
      code_verifier: string;
      client_id: string;
      redirect_uri: string;
    },
  ): Promise<object> {
    return this.api.exchange(body);
  }

  @Post("auth/token/refresh")
  refresh(@Body() body: { refresh_token: string }): object {
    return this.api.refresh(body.refresh_token);
  }

  @Post("auth/revoke")
  revoke(@Body() body: { token: string }, @Res() response: Response): void {
    this.api.revoke(body.token);
    response.status(204).send();
  }

  @Get("me/profile")
  async profile(@Headers("authorization") auth?: string): Promise<object> {
    return this.api.profile(auth);
  }

  @Get("me/appointments")
  async myAppointments(
    @Headers("authorization") auth?: string,
  ): Promise<object[]> {
    return this.api.listAppointments(await this.api.user(auth));
  }

  @Get("professionals")
  async professionals(): Promise<object[]> {
    return this.api.professionals();
  }

  @Get("availability")
  async availability(
    @Headers("authorization") auth: string,
    @Query("professionalId") professionalId: string,
    @Query("from") from: string,
    @Query("to") to: string,
  ): Promise<object[]> {
    const user = await this.api.user(auth);
    if (user.role !== "patient")
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    return this.api.availability(Number(professionalId), from, to);
  }

  @Post("appointments")
  async book(
    @Headers("authorization") auth: string,
    @Body() body: { professionalId: number; slotStart: string },
  ): Promise<object> {
    return this.api.book(
      await this.api.user(auth),
      Number(body.professionalId),
      body.slotStart,
    );
  }

  @Delete("appointments/:id")
  async cancel(
    @Headers("authorization") auth: string,
    @Param("id", ParseIntPipe) id: number,
    @Res() response: Response,
  ): Promise<void> {
    await this.api.cancel(await this.api.user(auth), id);
    response.status(204).send();
  }

  @Get("agenda")
  async agenda(
    @Headers("authorization") auth: string,
    @Query("from") from: string,
    @Query("to") to: string,
  ): Promise<object[]> {
    return this.api.agenda(await this.api.user(auth), from, to);
  }

  @Get("appointments/:id")
  async appointment(
    @Headers("authorization") auth: string,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<object> {
    return this.api.appointment(await this.api.user(auth), id);
  }

  @Post("appointments/:id/encounter")
  async encounter(
    @Headers("authorization") auth: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { notes: string; diagnosis: string },
  ): Promise<object> {
    return this.api.encounter(
      await this.api.user(auth),
      id,
      body.notes,
      body.diagnosis,
    );
  }

  @Get("patients/:id/clinical-history")
  async history(
    @Headers("authorization") auth: string,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<object[]> {
    return this.api.history(await this.api.user(auth), id);
  }

  @Post("encounters/:id/attachments")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 5 * 1024 * 1024 },
      storage: diskStorage({
        destination: (_req, _file, callback) => {
          const folder = path.join("/tmp", "medapp-attachments");
          fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
          callback(null, folder);
        },
        filename: (_req, file, callback) =>
          callback(
            null,
            randomBytes(24).toString("hex") +
              path.extname(file.originalname).toLowerCase(),
          ),
      }),
    }),
  )
  async upload(
    @Headers("authorization") auth: string,
    @Param("id", ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<object> {
    const user = await this.api.user(auth);
    if (user.role !== "professional")
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    if (
      !file ||
      !["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype)
    )
      throw Object.assign(new Error("Unsupported file type"), { status: 415 });
    const appointment = await this.api.poolAppointmentForAttachment(
      id,
      user.professionalId as number,
    );
    const filename =
      path
        .basename(file.originalname)
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 120) || "attachment";
    return {
      id: await this.api.insertAttachment(
        id,
        filename,
        file.mimetype,
        file.path,
      ),
      appointment,
    };
  }

  @Get("attachments/:id")
  async download(
    @Headers("authorization") auth: string,
    @Param("id", ParseIntPipe) id: number,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.api.attachmentAccess(await this.api.user(auth), id);
    response.sendFile(file);
  }

  @Get("admin/users")
  async users(
    @Headers("authorization") auth: string,
    @Query("page") page = "1",
  ): Promise<object> {
    return this.api.users(await this.api.user(auth), Math.max(1, Number(page)));
  }

  @Post("admin/users")
  async createUser(
    @Headers("authorization") auth: string,
    @Body() body: { email: string; roles: string[] },
  ): Promise<object> {
    return this.api.createUser(
      await this.api.user(auth),
      body.email,
      body.roles,
    );
  }

  @Patch("admin/users/:id/roles")
  async updateRoles(
    @Headers("authorization") auth: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { roles: string[] },
  ): Promise<object> {
    return this.api.updateRoles(await this.api.user(auth), id, body.roles);
  }

  @Put("admin/professionals/:id/availability")
  async setAvailability(
    @Headers("authorization") auth: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { slots: Array<{ start: string; end: string }> },
  ): Promise<object> {
    return this.api.setAvailability(await this.api.user(auth), id, body.slots);
  }

  @Get("admin/audit")
  async audit(
    @Headers("authorization") auth: string,
    @Query()
    filters: { actor?: string; action?: string; from?: string; to?: string },
  ): Promise<object> {
    return this.api.auditLog(await this.api.user(auth), filters);
  }
}
