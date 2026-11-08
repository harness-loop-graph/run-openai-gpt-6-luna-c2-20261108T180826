# Medical Appointments architecture

## Entities

`usuario` has many `rol` values through `usuario_rol`; users map one-to-one to `paciente` or `profesional`. `disponibilidad` belongs to a professional. `cita` joins a patient and professional at an available slot. `encuentro` belongs to an appointment and is append-only; `replaced_id` links a correction to its predecessor. `adjunto` belongs to an encounter. `auditoria` is append-only and records actor, action, resource and timestamp.

## Endpoint-to-screen map

| Endpoint | Screen or service |
| --- | --- |
| EP-01–04 | SCR-01 OAuth login and callback |
| EP-05, EP-08 | SCR-02 Patient appointments and cancellation |
| EP-06, EP-07 | SCR-03 Search and booking |
| EP-09, EP-10 | SCR-04 Professional agenda and SCR-05 detail |
| EP-11 | SCR-05 encounter recording |
| EP-12, EP-14 | SCR-06 Clinical history and attachments |
| EP-13 | SCR-06 Encounter attachment upload |
| EP-15–18 | SCR-07 Administration |
| EP-19 | SCR-08 Audit log |
| EP-20 | Health check |
