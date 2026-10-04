-- Nombre de referencia interna (solo para los novios), aparte del nombre que ve el invitado.
-- Aplicada en el proyecto ejuwrotykcyuuofklvqc el 2026-10-04.
alter table public.invitaciones add column nombre_interno text;
update public.invitaciones set nombre_interno = nombre where nombre_interno is null;
alter table public.invitaciones
  alter column nombre_interno set not null,
  add constraint invitaciones_nombre_interno_largo check (char_length(nombre_interno) between 1 and 120);

comment on column public.invitaciones.nombre is 'Cómo ve el invitado su invitación (saludo en el sobre, RSVP y pase).';
comment on column public.invitaciones.nombre_interno is 'Referencia interna de los novios; nunca se muestra al invitado.';
