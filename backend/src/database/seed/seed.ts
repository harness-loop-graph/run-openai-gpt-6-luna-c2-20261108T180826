import { Pool } from "pg";
import * as bcrypt from "bcryptjs";

export async function seed(pool: Pool): Promise<void> {
  const roles = ["admin", "staff", "patient", "professional"];
  for (const role of roles) {
    await pool.query(
      "INSERT INTO rol(nombre) VALUES($1) ON CONFLICT(nombre) DO NOTHING",
      [role],
    );
  }
  const password = await bcrypt.hash(
    process.env.SEED_PASSWORD ?? "Seed!Passw0rd",
    10,
  );
  const accounts = [
    ["admin@seed.local", "admin", "Admin"],
    ["staff@seed.local", "staff", "Staff"],
    ["paciente1@seed.local", "patient", "Paciente Uno"],
    ["paciente2@seed.local", "patient", "Paciente Dos"],
    ["paciente3@seed.local", "patient", "Paciente Tres"],
    ["gomez@seed.local", "professional", "Gómez"],
    ["lopez@seed.local", "professional", "López"],
  ];
  for (const [email, role, name] of accounts) {
    await pool.query(
      "INSERT INTO usuario(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO NOTHING",
      [email, password],
    );
    const user = await pool.query("SELECT id FROM usuario WHERE email=$1", [
      email,
    ]);
    const roleRow = await pool.query("SELECT id FROM rol WHERE nombre=$1", [
      role,
    ]);
    await pool.query(
      "INSERT INTO usuario_rol(usuario_id,rol_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [user.rows[0].id, roleRow.rows[0].id],
    );
    if (role === "patient") {
      await pool.query(
        "INSERT INTO paciente(usuario_id,nombre) VALUES($1,$2) ON CONFLICT(usuario_id) DO NOTHING",
        [user.rows[0].id, name],
      );
    }
    if (role === "professional") {
      await pool.query(
        "INSERT INTO profesional(usuario_id,nombre) VALUES($1,$2) ON CONFLICT(usuario_id) DO NOTHING",
        [user.rows[0].id, name],
      );
    }
  }
  const professionals = await pool.query(
    "SELECT id,nombre FROM profesional ORDER BY id",
  );
  const today = new Date();
  for (const professional of professionals.rows) {
    for (let offset = 0; offset < 14; offset += 1) {
      const day = new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate() + offset,
        ),
      );
      if (
        day.getUTCDay() === 0 ||
        day.getUTCDay() === 6 ||
        (professional.nombre === "López" && day.getUTCDay() === 5)
      ) {
        continue;
      }
      for (let minute = 8 * 60; minute < 16 * 60; minute += 30) {
        const start = new Date(day.getTime() + minute * 60000);
        const end = new Date(start.getTime() + 30 * 60000);
        await pool.query(
          "INSERT INTO disponibilidad(profesional_id,franja_inicio,franja_fin) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [professional.id, start.toISOString(), end.toISOString()],
        );
      }
    }
  }
}
