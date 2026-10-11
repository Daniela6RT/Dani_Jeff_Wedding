-- Última vez que se envió el recordatorio de confirmar por WhatsApp.
alter table public.invitaciones add column if not exists recordado_en timestamptz;
