-- Cada persona invitada, dentro de su invitación (para mesas y organización).
-- Aplicada en el proyecto ejuwrotykcyuuofklvqc el 2026-10-07.
-- Los datos (nombres de invitados) se cargaron directamente en la base y NO
-- se guardan en este repositorio, que es público.
create table public.personas (
  id uuid primary key default gen_random_uuid(),
  invitacion_id uuid not null references public.invitaciones(id) on delete cascade,
  nombre text check (nombre is null or char_length(nombre) between 1 and 80), -- null: +1 por definir
  rol text not null check (rol in ('principal', 'acompanante')),
  acompanante_de uuid references public.personas(id) on delete set null,
  orden smallint not null default 1,
  mesa text,
  notas text,
  creada_en timestamptz not null default now(),
  check ((rol = 'acompanante') = (acompanante_de is not null))
);
create index personas_invitacion on public.personas (invitacion_id, orden);
alter table public.personas enable row level security;  -- sin políticas: solo el panel (service role)
comment on table public.personas is 'Personas de cada invitación. Solo accesible desde el panel de administración.';

-- La corte se enlaza a su persona concreta
alter table public.corte add column persona_id uuid references public.personas(id) on delete set null;
