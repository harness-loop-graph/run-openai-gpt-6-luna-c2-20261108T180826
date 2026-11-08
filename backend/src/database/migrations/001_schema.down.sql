DROP TRIGGER IF EXISTS auditoria_append_only ON auditoria;
DROP TRIGGER IF EXISTS encuentro_append_only ON encuentro;
DROP FUNCTION IF EXISTS prevent_append_only_mutation();
DROP TABLE IF EXISTS adjunto, encuentro, auditoria, cita, disponibilidad, profesional, paciente, usuario_rol, rol, usuario CASCADE;
