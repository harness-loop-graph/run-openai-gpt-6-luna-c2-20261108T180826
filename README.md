# Medical Appointments

Local outpatient scheduling and clinical history application using NestJS, PostgreSQL 16, React, Vitest and Playwright.

## Run

Copy `.env.example` to `.env`, then run `docker compose up -d --build`. Database migrations and deterministic seed execute automatically. Services: SPA `http://localhost:8080`, API `http://localhost:3000`, PostgreSQL `localhost:5432` (defaults `medapp` / `medapp`). Seed credentials use `SEED_PASSWORD` (default `Seed!Passw0rd`); seed users include `admin@seed.local`, `staff@seed.local`, `paciente1@seed.local` through `paciente3@seed.local`, `gomez@seed.local` and `lopez@seed.local`.

## Development checks

- `cd backend && npm test`
- `cd frontend && npm run build`
- `npm install && npx playwright test` at the root against the running stack
