-- Tareas de la boda (checklist por fases y trámites), con responsable y
-- fecha límite. Reemplaza al Checklist y a Documentos y Trámites de Notion.
create table public.tareas (
  id uuid primary key default gen_random_uuid(),
  titulo text not null check (char_length(titulo) between 1 and 160),
  notas text check (notas is null or char_length(notas) <= 1000),
  tipo text not null default 'general' check (tipo in ('general', 'civil', 'finca')),
  fase smallint check (fase between 1 and 5),
  responsable text not null default 'ambos' check (responsable in ('daniela', 'jeferson', 'ambos', 'familia')),
  estado text not null default 'sin_empezar' check (estado in ('sin_empezar', 'en_progreso', 'listo')),
  fecha_limite date,
  completada_en timestamptz,
  creada_en timestamptz not null default now(),
  actualizada_en timestamptz not null default now()
);
comment on table public.tareas is 'Tareas de organización de la boda. Solo panel de administración.';
create index tareas_estado_fecha on public.tareas (estado, fecha_limite);
alter table public.tareas enable row level security;
