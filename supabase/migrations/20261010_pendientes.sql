-- Lo que falta contratar. El estado se calcula en el panel según la
-- categoría: sin cotizaciones = por cotizar, con cotizaciones = cotizando,
-- con un proveedor de esa categoría = contratado.
create table public.pendientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (char_length(nombre) between 1 and 120),
  categoria text not null check (char_length(categoria) between 1 and 60),
  estimado numeric(12,0) check (estimado is null or estimado >= 0),
  notas text check (notas is null or char_length(notas) <= 1000),
  no_aplica boolean not null default false,
  orden smallint not null default 100,
  creado_en timestamptz not null default now()
);
comment on table public.pendientes is 'Lo que falta contratar para la boda. Solo panel de administración.';
create unique index pendientes_categoria on public.pendientes (lower(categoria));
alter table public.pendientes enable row level security;
