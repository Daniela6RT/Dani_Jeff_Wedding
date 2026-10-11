-- Kit de emergencia del día (lista para marcar) y contactos clave del día.
create table public.kit (
  id uuid primary key default gen_random_uuid(),
  item text not null check (char_length(item) between 1 and 160),
  listo boolean not null default false,
  creado_en timestamptz not null default now()
);
comment on table public.kit is 'Kit de emergencia del día de la boda. Solo panel de administración.';
alter table public.kit enable row level security;

create table public.contactos (
  id uuid primary key default gen_random_uuid(),
  rol text not null check (char_length(rol) between 1 and 80),
  nombre text check (nombre is null or char_length(nombre) <= 120),
  telefono text check (telefono is null or char_length(telefono) <= 40),
  notas text check (notas is null or char_length(notas) <= 500),
  orden smallint not null default 100,
  creado_en timestamptz not null default now()
);
comment on table public.contactos is 'Contactos clave del día de la boda (con teléfonos). Solo panel de administración.';
alter table public.contactos enable row level security;
