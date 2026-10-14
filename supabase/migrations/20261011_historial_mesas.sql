-- Historial de cambios hechos desde el panel (quién, qué y cuándo).
create table public.historial (
  id bigint generated always as identity primary key,
  quien text not null check (char_length(quien) <= 80),
  accion text not null check (char_length(accion) <= 40),
  detalle text not null check (char_length(detalle) <= 300),
  creado_en timestamptz not null default now()
);
comment on table public.historial is 'Quién cambió qué desde el panel. Solo panel de administración.';
create index historial_fecha on public.historial (creado_en desc);
alter table public.historial enable row level security;

-- Mesas del evento y la mesa asignada a cada persona.
create table public.mesas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (char_length(nombre) between 1 and 60),
  capacidad smallint not null default 8 check (capacidad between 1 and 40),
  orden smallint not null default 100,
  creada_en timestamptz not null default now()
);
comment on table public.mesas is 'Mesas del evento. Solo panel de administración.';
alter table public.mesas enable row level security;

alter table public.personas add column if not exists mesa_id uuid references public.mesas(id) on delete set null;
