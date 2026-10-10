-- Cotizaciones formales: se comparan por categoría y, si se aceptan,
-- pasan a ser proveedores. Solo accesibles desde el panel (service role).
create table public.cotizaciones (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (char_length(nombre) between 1 and 120),
  categoria text check (categoria is null or char_length(categoria) <= 60),
  contacto text check (contacto is null or char_length(contacto) <= 120),
  monto numeric(12,0) not null check (monto >= 0),
  fecha date,
  notas text check (notas is null or char_length(notas) <= 1000),
  archivo_path text,
  estado text not null default 'evaluacion' check (estado in ('evaluacion', 'contratada', 'descartada')),
  proveedor_id uuid references public.proveedores(id) on delete set null,
  creada_en timestamptz not null default now(),
  -- solo una cotización contratada queda enlazada a su proveedor
  check (estado = 'contratada' or proveedor_id is null)
);
comment on table public.cotizaciones is 'Cotizaciones de posibles proveedores. Solo panel de administración.';
create index cotizaciones_categoria on public.cotizaciones (categoria, estado);
alter table public.cotizaciones enable row level security;

-- Archivos de las cotizaciones (PDF o imagen), privados
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cotizaciones', 'cotizaciones', false, 8388608,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;
