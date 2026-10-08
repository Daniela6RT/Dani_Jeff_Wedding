-- Teléfono de contacto de cada invitación (privado: no lo devuelve ninguna
-- función pública ni el panel). Los números se cargan desde el Sheet,
-- nunca se guardan en este repo.
alter table public.invitaciones
  add column telefono text check (telefono is null or telefono ~ '^\+[0-9]{8,15}$');
