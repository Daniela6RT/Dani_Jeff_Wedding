-- Cronograma del día de la boda (y del día siguiente): hora, actividad,
-- responsable, lugar, canción del momento y notas.
create table public.cronograma (
  id uuid primary key default gen_random_uuid(),
  dia date not null default '2027-03-20',
  hora time not null,
  hora_fin time,
  actividad text not null check (char_length(actividad) between 1 and 160),
  responsable text check (responsable is null or char_length(responsable) <= 60),
  ubicacion text check (ubicacion is null or char_length(ubicacion) <= 120),
  cancion text check (cancion is null or char_length(cancion) <= 160),
  notas text check (notas is null or char_length(notas) <= 1000),
  creado_en timestamptz not null default now()
);
comment on table public.cronograma is 'Cronograma del día de la boda. Solo panel de administración.';
create index cronograma_orden on public.cronograma (dia, hora);
alter table public.cronograma enable row level security;
