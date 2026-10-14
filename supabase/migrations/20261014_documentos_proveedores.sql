-- Documentos de cada proveedor (contrato firmado, anexos, facturas…) en un bucket privado.
create table public.documentos (
  id uuid primary key default gen_random_uuid(),
  proveedor_id uuid not null references public.proveedores(id) on delete cascade,
  nombre text not null check (char_length(nombre) between 1 and 120),
  archivo_path text not null,
  creado_en timestamptz not null default now()
);
comment on table public.documentos is 'Contratos y documentos de proveedores. Solo panel de administración.';
create index documentos_proveedor on public.documentos (proveedor_id, creado_en);
alter table public.documentos enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contratos', 'contratos', false, 10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;
