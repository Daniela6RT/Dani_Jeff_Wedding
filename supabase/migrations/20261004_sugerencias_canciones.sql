-- Sugerencias de canciones: solo con código de invitación, máximo 5 por invitación.
-- Aplicada en el proyecto ejuwrotykcyuuofklvqc el 2026-10-04.
create table public.sugerencias_canciones (
  id uuid primary key default gen_random_uuid(),
  invitacion_id uuid not null references public.invitaciones(id) on delete cascade,
  titulo text not null check (char_length(titulo) between 1 and 200),
  artista text not null check (char_length(artista) between 1 and 200),
  spotify_id text check (spotify_id ~ '^[A-Za-z0-9]{10,40}$'),
  spotify_url text check (spotify_url ~ '^https://open\.spotify\.com/'),
  portada_url text check (portada_url ~ '^https://i\.scdn\.co/'),
  creada_en timestamptz not null default now()
);
alter table public.sugerencias_canciones enable row level security;
-- La misma canción no se repite dentro de una invitación
create unique index sugerencias_unica on public.sugerencias_canciones (invitacion_id, lower(titulo), lower(artista));

-- Canciones sugeridas por una invitación (solo las suyas)
create or replace function public.mis_canciones(p_codigo text)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(json_agg(json_build_object(
    'id', s.id, 'titulo', s.titulo, 'artista', s.artista,
    'spotify_url', s.spotify_url, 'portada_url', s.portada_url
  ) order by s.creada_en), '[]'::json)
  from public.sugerencias_canciones s
  join public.invitaciones i on i.id = s.invitacion_id
  where i.codigo = lower(trim(p_codigo));
$$;

create or replace function public.sugerir_cancion(
  p_codigo text,
  p_titulo text,
  p_artista text,
  p_spotify_id text default null,
  p_spotify_url text default null,
  p_portada_url text default null
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inv_id uuid;
  n integer;
begin
  select id into inv_id from public.invitaciones where codigo = lower(trim(p_codigo));
  if inv_id is null then
    raise exception 'codigo_invalido' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_titulo), '') = '' or coalesce(trim(p_artista), '') = '' then
    raise exception 'falta_cancion' using errcode = 'P0001';
  end if;
  select count(*) into n from public.sugerencias_canciones where invitacion_id = inv_id;
  if n >= 5 then
    raise exception 'limite_canciones' using errcode = 'P0001';
  end if;
  begin
    insert into public.sugerencias_canciones (invitacion_id, titulo, artista, spotify_id, spotify_url, portada_url)
    values (inv_id, left(trim(p_titulo), 200), left(trim(p_artista), 200),
            nullif(p_spotify_id, ''), nullif(p_spotify_url, ''), nullif(p_portada_url, ''));
  exception when unique_violation then
    raise exception 'cancion_repetida' using errcode = 'P0001';
  end;
  return public.mis_canciones(p_codigo);
end;
$$;

create or replace function public.quitar_cancion(p_codigo text, p_id uuid)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.sugerencias_canciones s
  using public.invitaciones i
  where s.id = p_id and i.id = s.invitacion_id and i.codigo = lower(trim(p_codigo));
  return public.mis_canciones(p_codigo);
end;
$$;

revoke all on function public.mis_canciones(text) from public;
revoke all on function public.sugerir_cancion(text, text, text, text, text, text) from public;
revoke all on function public.quitar_cancion(text, uuid) from public;
grant execute on function public.mis_canciones(text) to anon, authenticated;
grant execute on function public.sugerir_cancion(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.quitar_cancion(text, uuid) to anon, authenticated;
