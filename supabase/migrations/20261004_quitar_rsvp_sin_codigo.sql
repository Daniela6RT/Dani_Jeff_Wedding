-- Las respuestas ahora solo entran por responder_invitacion (con código).
-- Se quita el permiso que dejaba insertar en rsvps sin invitación.
-- Aplicada en el proyecto ejuwrotykcyuuofklvqc el 2026-10-04.
drop policy if exists "public can submit rsvp" on public.rsvps;
