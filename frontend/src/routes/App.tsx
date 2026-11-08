import { FormEvent, useEffect, useState } from "react";
import { request, token } from "../api/client";
import { startLogin } from "../auth/pkce";

type Profile = {
  id: number;
  role: string;
  patientId?: number;
  professionalId?: number;
};
type Appointment = {
  id: number;
  start: string;
  end: string;
  estado: string;
  professional?: string;
  patient?: string;
};
type Slot = { start: string; end: string };

function Loading() {
  return <p data-testid="loading-indicator">Loading…</p>;
}
function Empty() {
  return <p data-testid="empty-state">No records found.</p>;
}

export function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [page, setPage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [professionals, setProfessionals] = useState<
    Array<{ id: number; nombre: string }>
  >([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selected, setSelected] = useState("");
  const [professionalId, setProfessionalId] = useState("1");
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);
  const [activeAppointment, setActiveAppointment] = useState<number | null>(
    null,
  );
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([]);
  const [audit, setAudit] = useState<Array<Record<string, unknown>>>([]);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (window.location.pathname === "/auth/callback" && code) {
      const expected = sessionStorage.getItem("oauth_state");
      if (params.get("state") !== expected) {
        setError("OAuth state mismatch");
        return;
      }
      const verifier = sessionStorage.getItem("pkce_verifier") ?? "";
      void request<{ access_token: string; refresh_token: string }>(
        "/auth/token",
        {
          method: "POST",
          body: JSON.stringify({
            code,
            code_verifier: verifier,
            client_id: "medapp-spa",
            redirect_uri: "http://localhost:8080/auth/callback",
          }),
        },
      )
        .then(async (tokens) => {
          sessionStorage.setItem("access_token", tokens.access_token);
          sessionStorage.setItem("refresh_token", tokens.refresh_token);
          const user = await request<Profile>("/me/profile");
          sessionStorage.setItem("role", user.role);
          sessionStorage.setItem("user_id", String(user.id));
          if (user.patientId)
            sessionStorage.setItem("patient_id", String(user.patientId));
          if (user.professionalId)
            sessionStorage.setItem(
              "professional_id",
              String(user.professionalId),
            );
          setProfile(user);
          window.history.replaceState({}, "", "/");
        })
        .catch((reason: Error) => setError(reason.message));
      return;
    }
    const access = token();
    const role = sessionStorage.getItem("role");
    if (!access || !role) {
      if (window.location.pathname !== "/") window.location.replace("/");
      return;
    }
    void request<Profile>("/me/profile")
      .then(setProfile)
      .catch(() => {
        sessionStorage.clear();
        setProfile(null);
      });
    const refreshToken = sessionStorage.getItem("refresh_token");
    if (refreshToken) {
      const timer = window.setInterval(
        () => {
          void request<{ access_token: string; refresh_token: string }>(
            "/auth/token/refresh",
            {
              method: "POST",
              body: JSON.stringify({
                refresh_token: sessionStorage.getItem("refresh_token"),
              }),
            },
          )
            .then((fresh) => {
              sessionStorage.setItem("access_token", fresh.access_token);
              sessionStorage.setItem("refresh_token", fresh.refresh_token);
            })
            .catch(() => {
              sessionStorage.clear();
              setProfile(null);
            });
        },
        14 * 60 * 1000,
      );
      return () => window.clearInterval(timer);
    }
  }, []);

  async function run(task: () => Promise<void>): Promise<void> {
    setLoading(true);
    setError("");
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  function navigate(target: string): void {
    setPage(target);
    void run(async () => {
      if (target === "bookings" || target === "agenda") {
        const list =
          target === "bookings"
            ? await request<Appointment[]>("/me/appointments")
            : await request<Appointment[]>(
                `/agenda?from=${today}&to=${new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)}`,
              );
        setAppointments(list);
      }
      if (target === "search")
        setProfessionals(await request("/professionals"));
      if (target === "history") {
        const patientId =
          profile?.patientId ?? Number(window.prompt("Patient id"));
        if (patientId)
          setHistory(await request(`/patients/${patientId}/clinical-history`));
      }
      if (target === "admin") {
        const result = await request<{ items: Array<Record<string, unknown>> }>(
          "/admin/users",
        );
        setUsers(result.items);
      }
      if (target === "audit") {
        const result = await request<{ items: Array<Record<string, unknown>> }>(
          "/admin/audit",
        );
        setAudit(result.items);
      }
    });
  }

  async function search(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const from = String(data.get("from"));
    const to = String(data.get("to"));
    await run(async () =>
      setSlots(
        await request(
          `/availability?professionalId=${professionalId}&from=${from}&to=${to}`,
        ),
      ),
    );
  }

  async function book(): Promise<void> {
    if (!selected) return;
    await run(async () => {
      await request("/appointments", {
        method: "POST",
        body: JSON.stringify({
          professionalId: Number(professionalId),
          slotStart: selected,
        }),
      });
      setSelected("");
      setSlots([]);
    });
  }

  async function cancel(id: number): Promise<void> {
    await run(async () => {
      await request(`/appointments/${id}`, { method: "DELETE" });
      setAppointments(appointments.filter((item) => item.id !== id));
    });
  }

  function openAppointment(id: number): void {
    setActiveAppointment(id);
    setPage("detail");
  }

  async function saveEncounter(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!activeAppointment) return;
    const data = new FormData(event.currentTarget);
    await run(async () => {
      await request(`/appointments/${activeAppointment}/encounter`, {
        method: "POST",
        body: JSON.stringify({
          notes: data.get("notes"),
          diagnosis: data.get("diagnosis"),
        }),
      });
      setPage("agenda");
    });
  }

  async function logout(): Promise<void> {
    const refresh = sessionStorage.getItem("refresh_token");
    if (refresh)
      await request("/auth/revoke", {
        method: "POST",
        body: JSON.stringify({ token: refresh }),
      }).catch(() => undefined);
    sessionStorage.clear();
    setProfile(null);
    setPage("");
  }

  if (!profile) {
    if (
      window.location.pathname === "/auth/callback" &&
      new URLSearchParams(window.location.search).has("code")
    )
      return (
        <main>
          <h1>Signing in</h1>
          {loading && <Loading />}
          {error && <p data-testid="error-banner">{error}</p>}
        </main>
      );
    return (
      <main className="login">
        <h1>Medical Appointments</h1>
        <p>Sign in with your account</p>
        <button data-testid="login-submit" onClick={() => void startLogin()}>
          Continue to sign in
        </button>
      </main>
    );
  }

  const nav: Array<[string, string]> =
    profile.role === "patient"
      ? [
          ["bookings", "nav-bookings"],
          ["search", "nav-search"],
          ["history", "nav-history"],
        ]
      : profile.role === "professional"
        ? [
            ["agenda", "nav-agenda"],
            ["history", "nav-history"],
          ]
        : profile.role === "staff"
          ? [
              ["agenda", "nav-agenda"],
              ["search", "nav-search"],
            ]
          : [
              ["admin", "nav-admin"],
              ["audit", "nav-audit"],
            ];

  return (
    <div className="app">
      <header>
        <strong>Medical Appointments</strong>
        <nav>
          {nav.map(([target, test]) => (
            <button
              key={test}
              data-testid={test}
              onClick={() => navigate(target)}
            >
              {target}
            </button>
          ))}
          <button onClick={() => void logout()}>Log out</button>
        </nav>
      </header>
      <main>
        {loading && <Loading />}
        {error && (
          <p className="error" data-testid="error-banner">
            {error}
          </p>
        )}
        {!page && <h1>Welcome</h1>}
        {(page === "bookings" || page === "agenda") && (
          <section>
            <h1>{page === "bookings" ? "My appointments" : "Agenda"}</h1>
            {appointments.length === 0 ? (
              <Empty />
            ) : (
              appointments.map((item) => (
                <article
                  key={item.id}
                  data-testid="appointment-item"
                  data-appointment-id={item.id}
                  onClick={() => page === "agenda" && openAppointment(item.id)}
                >
                  <span>
                    {new Date(item.start).toLocaleString()} —{" "}
                    {item.professional ?? item.patient} ({item.estado})
                  </span>
                  {page === "bookings" && item.estado === "scheduled" && (
                    <button
                      data-testid="cancel-appointment"
                      onClick={(event) => {
                        event.stopPropagation();
                        void cancel(item.id);
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </article>
              ))
            )}
          </section>
        )}
        {page === "search" && (
          <section>
            <h1>Availability search</h1>
            <form onSubmit={(event) => void search(event)}>
              <label>
                Professional
                <select
                  data-testid="search-professional"
                  value={professionalId}
                  onChange={(event) => setProfessionalId(event.target.value)}
                >
                  {professionals.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.nombre}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                From
                <input
                  data-testid="search-from"
                  type="date"
                  name="from"
                  defaultValue={today}
                  required
                />
              </label>
              <label>
                To
                <input
                  data-testid="search-to"
                  type="date"
                  name="to"
                  defaultValue={today}
                  required
                />
              </label>
              <button data-testid="search-submit">Search</button>
            </form>
            {slots.length === 0 ? (
              <Empty />
            ) : (
              <ul>
                {slots.map((slot) => (
                  <li key={slot.start}>
                    <button
                      data-testid="slot-item"
                      data-slot-start={slot.start}
                      aria-pressed={selected === slot.start}
                      onClick={() => setSelected(slot.start)}
                    >
                      {new Date(slot.start).toLocaleString()}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              data-testid="book-submit"
              disabled={!selected}
              onClick={() => void book()}
            >
              Book selected slot
            </button>
          </section>
        )}
        {page === "detail" && (
          <section>
            <h1>Appointment detail</h1>
            <form onSubmit={(event) => void saveEncounter(event)}>
              <label>
                Notes
                <textarea data-testid="encounter-notes" name="notes" required />
              </label>
              <label>
                Diagnosis
                <input
                  data-testid="encounter-diagnosis"
                  name="diagnosis"
                  required
                />
              </label>
              <button data-testid="encounter-submit">Save encounter</button>
            </form>
          </section>
        )}
        {page === "history" && (
          <section>
            <h1>Clinical history</h1>
            <div data-testid="history-timeline">
              {history.length === 0 ? (
                <Empty />
              ) : (
                history.map((entry, index) => (
                  <article key={String(entry.id ?? index)}>
                    <p>{String(entry.notes)}</p>
                    <p>{String(entry.diagnosis)}</p>
                  </article>
                ))
              )}
            </div>
          </section>
        )}
        {page === "admin" && (
          <section>
            <h1>Administration</h1>
            {users.length === 0 ? (
              <Empty />
            ) : (
              users.map((user, index) => (
                <article key={index}>
                  {String(user.email)} — {String(user.roles)}
                </article>
              ))
            )}
          </section>
        )}
        {page === "audit" && (
          <section>
            <h1>Audit log</h1>
            {audit.length === 0 ? (
              <Empty />
            ) : (
              audit.map((entry, index) => (
                <article key={index}>
                  {String(entry.accion)} {String(entry.recurso_tipo)}{" "}
                  {String(entry.recurso_id)}
                </article>
              ))
            )}
          </section>
        )}
      </main>
    </div>
  );
}
