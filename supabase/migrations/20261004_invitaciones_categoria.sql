-- Categoría de cada invitación, igual que la hoja DATOS del Google Sheets de la boda.
-- Reemplaza nombre_interno (solo tenía copias de las invitaciones de prueba).
-- Aplicada en el proyecto ejuwrotykcyuuofklvqc el 2026-10-04.
create table public.categorias (
  nombre text primary key check (char_length(nombre) between 1 and 60),
  orden smallint not null default 0
);
alter table public.categorias enable row level security;
insert into public.categorias (nombre, orden) values
  ('FAMILIA DANI', 1),
  ('FAMILIA JEFER', 2),
  ('AMIGOS DANI', 3),
  ('AMIGOS JEFER', 4),
  ('AMIGOS CASA', 5);

alter table public.invitaciones
  add column categoria text references public.categorias(nombre) on update cascade;
comment on column public.invitaciones.categoria is 'Categoría del invitado (hoja DATOS del Sheets); solo para los novios.';

alter table public.invitaciones drop column nombre_interno;
