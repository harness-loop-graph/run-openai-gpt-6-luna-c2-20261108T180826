import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool, PoolClient } from "pg";
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import * as bcrypt from "bcryptjs";
import * as fs from "fs";
import * as path from "path";
import { seed } from "./database/seed/seed";

type User = {
  id: number;
  email: string;
  role: string;
  patientId?: number;
  professionalId?: number;
};

@Injectable()
export class ApiService implements OnModuleInit, OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  private readonly codes = new Map<
    string,
    { challenge: string; userId: number; expires: number }
  >();
  private readonly tokens = new Map<
    string,
    {
      userId: number;
      role: string;
      expires: number;
      revoked: boolean;
      kind: string;
    }
  >();
  private readonly authorizations = new Map<string, string>();

  async onModuleInit(): Promise<void> {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const migrationClient = await this.pool.connect();
    try {
      const exists = await migrationClient.query(
        "SELECT 1 FROM schema_migrations WHERE version='001_schema'",
      );
      if (!exists.rowCount) {
        const sql = fs.readFileSync(
          path.join(__dirname, "database/migrations/001_schema.up.sql"),
          "utf8",
        );
        await migrationClient.query("BEGIN");
        try {
          await migrationClient.query(sql);
          await migrationClient.query(
            "INSERT INTO schema_migrations(version) VALUES('001_schema')",
          );
          await migrationClient.query("COMMIT");
        } catch (error) {
          await migrationClient.query("ROLLBACK");
          throw error;
        }
      }
    } finally {
      migrationClient.release();
    }
    await seed(this.pool);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private async audit(
    userId: number | null,
    action: string,
    type: string,
    id: string,
  ): Promise<void> {
    await this.pool.query(
      "INSERT INTO auditoria(usuario_id,accion,recurso_tipo,recurso_id) VALUES($1,$2,$3,$4)",
      [userId, action, type, id],
    );
  }

  async authorize(query: Record<string, string>): Promise<string> {
    if (
      query.client_id !== "medapp-spa" ||
      query.redirect_uri !== "http://localhost:8080/auth/callback" ||
      query.response_type !== "code" ||
      query.code_challenge_method !== "S256" ||
      !query.code_challenge ||
      !query.state
    ) {
      throw Object.assign(new Error("Invalid authorization request"), {
        status: 400,
      });
    }
    const key = randomBytes(24).toString("hex");
    this.authorizations.set(key, JSON.stringify(query));
    return `/auth/login?request=${encodeURIComponent(key)}`;
  }

  authorizationRequest(key: string): Record<string, string> {
    const stored = this.authorizations.get(key);
    if (!stored) {
      throw Object.assign(new Error("Invalid authorization request"), {
        status: 400,
      });
    }
    return JSON.parse(stored) as Record<string, string>;
  }

  async login(
    email: string,
    password: string,
    request: string,
  ): Promise<string> {
    const stored = this.authorizations.get(request);
    if (!stored)
      throw Object.assign(new Error("Invalid authorization request"), {
        status: 400,
      });
    const q = JSON.parse(stored) as Record<string, string>;
    const result = await this.pool.query(
      "SELECT u.id,u.password_hash,r.nombre AS role FROM usuario u JOIN usuario_rol ur ON ur.usuario_id=u.id JOIN rol r ON r.id=ur.rol_id WHERE u.email=$1 AND u.activo=true",
      [email],
    );
    if (
      !result.rowCount ||
      !(await bcrypt.compare(password, result.rows[0].password_hash))
    )
      throw Object.assign(new Error("Invalid credentials"), { status: 401 });
    const code = randomBytes(32).toString("hex");
    this.codes.set(code, {
      challenge: q.code_challenge,
      userId: result.rows[0].id,
      expires: Date.now() + 300000,
    });
    const target = new URL(q.redirect_uri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", q.state);
    return target.toString();
  }

  async exchange(body: {
    code: string;
    code_verifier: string;
    client_id: string;
    redirect_uri: string;
  }): Promise<object> {
    const authorization = this.codes.get(body.code);
    if (
      !authorization ||
      authorization.expires < Date.now() ||
      body.client_id !== "medapp-spa" ||
      body.redirect_uri !== "http://localhost:8080/auth/callback"
    )
      throw Object.assign(new Error("Invalid code"), { status: 401 });
    const digest = createHash("sha256")
      .update(body.code_verifier)
      .digest("base64url");
    if (digest !== authorization.challenge)
      throw Object.assign(new Error("Bad verifier"), { status: 400 });
    this.codes.delete(body.code);
    const user = await this.pool.query(
      "SELECT r.nombre FROM usuario_rol ur JOIN rol r ON r.id=ur.rol_id WHERE ur.usuario_id=$1",
      [authorization.userId],
    );
    return this.issue(authorization.userId, user.rows[0].nombre);
  }

  private issue(userId: number, role: string): object {
    const access = randomBytes(32).toString("hex");
    const refresh = randomBytes(40).toString("hex");
    this.tokens.set(access, {
      userId,
      role,
      expires: Date.now() + 900000,
      revoked: false,
      kind: "access",
    });
    this.tokens.set(refresh, {
      userId,
      role,
      expires: Date.now() + 28800000,
      revoked: false,
      kind: "refresh",
    });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 900,
    };
  }

  refresh(token: string): object {
    const record = this.tokens.get(token);
    if (
      !record ||
      record.kind !== "refresh" ||
      record.revoked ||
      record.expires < Date.now()
    )
      throw Object.assign(new Error("Invalid or expired token"), {
        status: 401,
      });
    record.revoked = true;
    return this.issue(record.userId, record.role);
  }

  revoke(token: string): void {
    const record = this.tokens.get(token);
    if (!record || record.revoked || record.expires < Date.now())
      throw Object.assign(new Error("Invalid token"), { status: 401 });
    record.revoked = true;
  }

  async user(authorization?: string): Promise<User> {
    const token = authorization?.replace(/^Bearer\s+/i, "");
    const record = token ? this.tokens.get(token) : undefined;
    if (
      !record ||
      record.kind !== "access" ||
      record.revoked ||
      record.expires < Date.now()
    )
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    const row = await this.pool.query(
      "SELECT u.activo,p.id AS patient_id,pr.id AS professional_id FROM usuario u LEFT JOIN paciente p ON p.usuario_id=u.id LEFT JOIN profesional pr ON pr.usuario_id=u.id WHERE u.id=$1",
      [record.userId],
    );
    if (!row.rows[0]?.activo) {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    }
    const roles = await this.pool.query(
      "SELECT r.nombre FROM usuario_rol ur JOIN rol r ON r.id=ur.rol_id WHERE ur.usuario_id=$1 ORDER BY r.id",
      [record.userId],
    );
    const activeRole = roles.rows.find(
      (role: { nombre: string }) => role.nombre === record.role,
    );
    if (!activeRole) {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    }
    return {
      id: record.userId,
      email: "",
      role: activeRole.nombre,
      patientId: row.rows[0]?.patient_id,
      professionalId: row.rows[0]?.professional_id,
    };
  }

  async profile(authorization?: string): Promise<User> {
    const user = await this.user(authorization);
    const email = await this.userEmail(user.id);
    return { ...user, email };
  }

  private ensure(user: User, roles: string[]): void {
    if (!roles.includes(user.role))
      throw Object.assign(new Error("Forbidden"), { status: 403 });
  }

  private async userEmail(id: number): Promise<string> {
    const result = await this.pool.query(
      "SELECT email FROM usuario WHERE id=$1",
      [id],
    );
    return result.rows[0]?.email ?? "";
  }

  async listAppointments(user: User): Promise<object[]> {
    this.ensure(user, ["patient"]);
    const result = await this.pool.query(
      "SELECT c.id,c.franja_inicio AS start,c.franja_fin AS end,c.estado,p.nombre AS professional FROM cita c JOIN profesional p ON p.id=c.profesional_id WHERE c.paciente_id=$1 ORDER BY c.franja_inicio",
      [user.patientId],
    );
    return result.rows;
  }

  async availability(
    professionalId: number,
    from: string,
    to: string,
  ): Promise<object[]> {
    if (
      !Number.isInteger(professionalId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      from > to ||
      new Date(to).getTime() - new Date(from).getTime() > 31 * 86400000
    )
      throw Object.assign(new Error("Invalid date range"), { status: 422 });
    const result = await this.pool.query(
      "SELECT d.franja_inicio AS start,d.franja_fin AS end FROM disponibilidad d WHERE d.profesional_id=$1 AND d.franja_inicio >= $2::date AND d.franja_inicio < ($3::date + interval '1 day') AND NOT EXISTS (SELECT 1 FROM cita c WHERE c.profesional_id=d.profesional_id AND c.franja_inicio=d.franja_inicio AND c.estado <> 'cancelled') ORDER BY d.franja_inicio",
      [professionalId, from, to],
    );
    return result.rows;
  }

  async professionals(): Promise<object[]> {
    const result = await this.pool.query(
      "SELECT id,nombre FROM profesional ORDER BY id",
    );
    return result.rows;
  }

  async book(
    user: User,
    professionalId: number,
    slotStart: string,
  ): Promise<object> {
    this.ensure(user, ["patient"]);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const slot = await client.query(
        "SELECT franja_fin FROM disponibilidad WHERE profesional_id=$1 AND franja_inicio=$2 FOR UPDATE",
        [professionalId, slotStart],
      );
      if (!slot.rowCount)
        throw Object.assign(new Error("Slot unavailable"), { status: 422 });
      const conflict = await client.query(
        "SELECT 1 FROM cita WHERE profesional_id=$1 AND franja_inicio=$2 AND estado <> 'cancelled'",
        [professionalId, slotStart],
      );
      if (conflict.rowCount)
        throw Object.assign(new Error("Slot already booked"), { status: 409 });
      const result = await client.query(
        "INSERT INTO cita(paciente_id,profesional_id,franja_inicio,franja_fin) VALUES($1,$2,$3,$4) RETURNING id",
        [user.patientId, professionalId, slotStart, slot.rows[0].franja_fin],
      );
      await client.query(
        "INSERT INTO auditoria(usuario_id,accion,recurso_tipo,recurso_id) VALUES($1,$2,$3,$4)",
        [user.id, "appointment.book", "appointment", result.rows[0].id],
      );
      await client.query("COMMIT");
      return { id: result.rows[0].id };
    } catch (error) {
      await client.query("ROLLBACK");
      const candidate = error as { code?: string; status?: number };
      if (candidate.code === "23505")
        throw Object.assign(new Error("Slot already booked"), { status: 409 });
      throw error;
    } finally {
      client.release();
    }
  }

  async cancel(user: User, id: number): Promise<void> {
    this.ensure(user, ["patient"]);
    const result = await this.pool.query(
      "UPDATE cita SET estado='cancelled' WHERE id=$1 AND paciente_id=$2 AND estado='scheduled' RETURNING id",
      [id, user.patientId],
    );
    if (!result.rowCount) {
      const exists = await this.pool.query(
        "SELECT paciente_id FROM cita WHERE id=$1",
        [id],
      );
      if (!exists.rowCount)
        throw Object.assign(new Error("Not found"), { status: 404 });
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    await this.audit(user.id, "appointment.cancel", "appointment", String(id));
  }

  async agenda(user: User, from: string, to: string): Promise<object[]> {
    this.ensure(user, ["professional", "staff"]);
    const professionalId = user.professionalId;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      from > to
    ) {
      throw Object.assign(new Error("Invalid date range"), { status: 422 });
    }
    const result = await this.pool.query(
      "SELECT c.id,c.franja_inicio AS start,c.franja_fin AS end,c.estado, p.nombre AS patient FROM cita c JOIN paciente p ON p.id=c.paciente_id WHERE ($1::int IS NULL OR c.profesional_id=$1) AND c.franja_inicio >= $2::date AND c.franja_inicio < ($3::date + interval '1 day') ORDER BY c.franja_inicio",
      [professionalId ?? null, from, to],
    );
    return result.rows;
  }

  async appointment(user: User, id: number): Promise<object> {
    const result = await this.pool.query(
      "SELECT c.*,p.nombre AS patient,pr.nombre AS professional FROM cita c JOIN paciente p ON p.id=c.paciente_id JOIN profesional pr ON pr.id=c.profesional_id WHERE c.id=$1",
      [id],
    );
    if (!result.rowCount)
      throw Object.assign(new Error("Not found"), { status: 404 });
    const item = result.rows[0];
    if (
      !(
        (user.role === "patient" && item.paciente_id === user.patientId) ||
        (user.role === "professional" &&
          item.profesional_id === user.professionalId)
      )
    )
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    await this.audit(user.id, "appointment.read", "appointment", String(id));
    return item;
  }

  async encounter(
    user: User,
    id: number,
    notes: string,
    diagnosis: string,
  ): Promise<object> {
    this.ensure(user, ["professional"]);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const appointment = await client.query(
        "SELECT profesional_id FROM cita WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!appointment.rowCount)
        throw Object.assign(new Error("Not found"), { status: 404 });
      if (appointment.rows[0].profesional_id !== user.professionalId)
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      const prior = await client.query(
        "SELECT COALESCE(MAX(version),0) AS version FROM encuentro WHERE cita_id=$1",
        [id],
      );
      const replaced = await client.query(
        "SELECT id FROM encuentro WHERE cita_id=$1 ORDER BY version DESC LIMIT 1",
        [id],
      );
      const result = await client.query(
        "INSERT INTO encuentro(cita_id,version,replaced_id,notes,diagnosis,author_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,version,notes,diagnosis",
        [
          id,
          Number(prior.rows[0].version) + 1,
          replaced.rows[0]?.id ?? null,
          notes,
          diagnosis,
          user.professionalId,
        ],
      );
      await client.query("UPDATE cita SET estado='attended' WHERE id=$1", [id]);
      await client.query(
        "INSERT INTO auditoria(usuario_id,accion,recurso_tipo,recurso_id) VALUES($1,$2,$3,$4)",
        [user.id, "encounter.create", "encounter", result.rows[0].id],
      );
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async history(user: User, patientId: number): Promise<object[]> {
    if (user.role === "patient" && user.patientId !== patientId)
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    if (user.role === "professional") {
      const assigned = await this.pool.query(
        "SELECT 1 FROM cita c JOIN paciente p ON p.id=c.paciente_id WHERE p.id=$1 AND c.profesional_id=$2 LIMIT 1",
        [patientId, user.professionalId],
      );
      if (!assigned.rowCount)
        throw Object.assign(new Error("Forbidden"), { status: 403 });
    } else if (user.role !== "patient")
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    const result = await this.pool.query(
      "SELECT e.id,e.notes,e.diagnosis,e.version,e.creado_en AS date,c.id AS appointment_id,a.id AS attachment_id,a.filename FROM encuentro e JOIN cita c ON c.id=e.cita_id LEFT JOIN adjunto a ON a.encuentro_id=e.id WHERE c.paciente_id=$1 ORDER BY e.creado_en,e.id",
      [patientId],
    );
    await this.audit(
      user.id,
      "clinical-history.read",
      "patient",
      String(patientId),
    );
    return result.rows;
  }

  async createUser(
    user: User,
    email: string,
    roles: string[],
  ): Promise<object> {
    this.ensure(user, ["admin"]);
    if (
      !roles.length ||
      roles.some(
        (role) => !["admin", "staff", "patient", "professional"].includes(role),
      )
    )
      throw Object.assign(new Error("Unknown role"), { status: 422 });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        "INSERT INTO usuario(email,password_hash) VALUES($1,$2) RETURNING id,email",
        [email, await bcrypt.hash(randomBytes(20).toString("hex"), 10)],
      );
      for (const role of roles) {
        const row = await client.query("SELECT id FROM rol WHERE nombre=$1", [
          role,
        ]);
        await client.query(
          "INSERT INTO usuario_rol(usuario_id,rol_id) VALUES($1,$2)",
          [inserted.rows[0].id, row.rows[0].id],
        );
      }
      await client.query("COMMIT");
      await this.audit(user.id, "user.create", "user", inserted.rows[0].id);
      return inserted.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      const candidate = error as { code?: string };
      if (candidate.code === "23505")
        throw Object.assign(new Error("Email exists"), { status: 409 });
      throw error;
    } finally {
      client.release();
    }
  }

  async users(user: User, page: number): Promise<object> {
    this.ensure(user, ["admin"]);
    const result = await this.pool.query(
      "SELECT u.id,u.email,array_agg(r.nombre ORDER BY r.nombre) AS roles FROM usuario u JOIN usuario_rol ur ON ur.usuario_id=u.id JOIN rol r ON r.id=ur.rol_id GROUP BY u.id ORDER BY u.id LIMIT 20 OFFSET $1",
      [(page - 1) * 20],
    );
    return { page, items: result.rows };
  }

  async updateRoles(user: User, id: number, roles: string[]): Promise<object> {
    this.ensure(user, ["admin"]);
    if (
      !roles.length ||
      roles.some(
        (role) => !["admin", "staff", "patient", "professional"].includes(role),
      )
    )
      throw Object.assign(new Error("Unknown role"), { status: 422 });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT id FROM usuario WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!existing.rowCount)
        throw Object.assign(new Error("Not found"), { status: 404 });
      await client.query("DELETE FROM usuario_rol WHERE usuario_id=$1", [id]);
      for (const role of roles) {
        const roleId = await client.query(
          "SELECT id FROM rol WHERE nombre=$1",
          [role],
        );
        await client.query(
          "INSERT INTO usuario_rol(usuario_id,rol_id) VALUES($1,$2)",
          [id, roleId.rows[0].id],
        );
      }
      await client.query("COMMIT");
      await this.audit(user.id, "user.roles.update", "user", String(id));
      return { id, roles };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setAvailability(
    user: User,
    professionalId: number,
    slots: Array<{ start: string; end: string }>,
  ): Promise<object> {
    this.ensure(user, ["admin"]);
    const sorted = [...slots].sort((a, b) => a.start.localeCompare(b.start));
    if (
      sorted.some(
        (slot, index) =>
          !Number.isFinite(Date.parse(slot.start)) ||
          !Number.isFinite(Date.parse(slot.end)) ||
          slot.start >= slot.end ||
          (index > 0 && sorted[index - 1].end > slot.start),
      )
    )
      throw Object.assign(new Error("Overlapping or invalid slots"), {
        status: 422,
      });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM disponibilidad WHERE profesional_id=$1 AND NOT EXISTS (SELECT 1 FROM cita c WHERE c.profesional_id=$1 AND c.franja_inicio=disponibilidad.franja_inicio AND c.estado <> 'cancelled')",
        [professionalId],
      );
      for (const slot of slots)
        await client.query(
          "INSERT INTO disponibilidad(profesional_id,franja_inicio,franja_fin) VALUES($1,$2,$3) ON CONFLICT(profesional_id,franja_inicio) DO UPDATE SET franja_fin=EXCLUDED.franja_fin",
          [professionalId, slot.start, slot.end],
        );
      await client.query("COMMIT");
      await this.audit(
        user.id,
        "availability.replace",
        "professional",
        String(professionalId),
      );
      return { slots };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async auditLog(
    user: User,
    filters: { actor?: string; action?: string; from?: string; to?: string },
  ): Promise<object> {
    this.ensure(user, ["admin"]);
    const result = await this.pool.query(
      "SELECT a.id,a.usuario_id,a.accion,a.recurso_tipo,a.recurso_id,a.creado_en FROM auditoria a LEFT JOIN usuario u ON u.id=a.usuario_id WHERE ($1::text IS NULL OR u.email=$1) AND ($2::text IS NULL OR a.accion=$2) AND ($3::date IS NULL OR a.creado_en >= $3::date) AND ($4::date IS NULL OR a.creado_en < ($4::date + interval '1 day')) ORDER BY a.creado_en DESC LIMIT 100",
      [
        filters.actor ?? null,
        filters.action ?? null,
        filters.from ?? null,
        filters.to ?? null,
      ],
    );
    return { items: result.rows };
  }

  async recordClinicalRead(user: User, id: number): Promise<void> {
    await this.audit(user.id, "attachment.read", "attachment", String(id));
  }

  async poolAppointmentForAttachment(
    encounterId: number,
    professionalId: number,
  ): Promise<number> {
    const result = await this.pool.query(
      "SELECT c.id FROM encuentro e JOIN cita c ON c.id=e.cita_id WHERE e.id=$1 AND e.author_id=$2",
      [encounterId, professionalId],
    );
    if (!result.rowCount)
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    return result.rows[0].id;
  }

  async insertAttachment(
    encounterId: number,
    filename: string,
    mimeType: string,
    storagePath: string,
  ): Promise<number> {
    const result = await this.pool.query(
      "INSERT INTO adjunto(encuentro_id,filename,mime_type,storage_path) VALUES($1,$2,$3,$4) RETURNING id",
      [encounterId, filename, mimeType, storagePath],
    );
    return result.rows[0].id;
  }

  async attachmentAccess(user: User, id: number): Promise<string> {
    const result = await this.pool.query(
      "SELECT a.storage_path,c.paciente_id,c.profesional_id,e.author_id FROM adjunto a JOIN encuentro e ON e.id=a.encuentro_id JOIN cita c ON c.id=e.cita_id WHERE a.id=$1",
      [id],
    );
    if (!result.rowCount)
      throw Object.assign(new Error("Not found"), { status: 404 });
    const row = result.rows[0];
    if (
      !(
        (user.role === "patient" && row.paciente_id === user.patientId) ||
        (user.role === "professional" &&
          row.profesional_id === user.professionalId)
      )
    )
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    await this.audit(user.id, "attachment.read", "attachment", String(id));
    return row.storage_path;
  }
}
