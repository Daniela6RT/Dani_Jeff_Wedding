-- Personas que se sientan en las mesas pero no son invitados del RSVP (los novios, y
-- quien se quiera añadir después). No afectan los conteos de confirmaciones.
create table public.mesa_extras (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (char_length(nombre) between 1 and 80),
  etiqueta text check (etiqueta is null or char_length(etiqueta) <= 40),
  mesa_id uuid references public.mesas(id) on delete set null,
  orden smallint not null default 100,
  creado_en timestamptz not null default now()
);
comment on table public.mesa_extras is 'Personas en las mesas que no son invitados (p. ej. los novios). Solo panel.';
alter table public.mesa_extras enable row level security;

insert into public.mesa_extras (nombre, etiqueta, orden) values
  ('Daniela', 'Novia', 1),
  ('Jeferson', 'Novio', 2);
