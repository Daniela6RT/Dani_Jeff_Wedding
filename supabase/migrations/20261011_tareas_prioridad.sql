-- Prioridad de cada tarea (alta / media / baja). Opcional.
alter table public.tareas add column if not exists prioridad text
  check (prioridad in ('alta', 'media', 'baja'));
