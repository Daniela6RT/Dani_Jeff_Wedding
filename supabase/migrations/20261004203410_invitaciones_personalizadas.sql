-- Invitaciones personalizadas: un código por invitación con sus cupos.
-- Solo agrega; no modifica datos ni permisos existentes de rsvps.
-- Aplicada en el proyecto ejuwrotykcyuuofklvqc el 2026-10-04.

-- Código de 8 caracteres sin letras ambiguas (sin i, l, o, 0, 1), a partir
-- de gen_random_uuid(), que usa un generador aleatorio criptográfico.
create or replace function public.nuevo_codigo()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alfabeto constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  bytes bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  codigo text := '';
begin
  for i in 0..7 loop
    codigo := codigo || substr(alfabeto, (get_byte(bytes, i) % 31) + 1, 1);
  end loop;
  return codigo;
end;
$$;

create table public.invitaciones (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique default public.nuevo_codigo() check (codigo ~ '^[a-z0-9]{8}$'),
  nombre text not null check (char_length(nombre) between 1 and 120),
  cupos smallint not null default 1 check (cupos between 1 and 10),
  notas text,
  creada_en timestamptz not null default now()
);
-- Sin políticas: nadie la lee directamente; solo a través de las funciones.
alter table public.invitaciones enable row level security;

-- Ajustes generales (una sola fila). fecha_limite_cambios = null: sin límite.
create table public.ajustes (
  id boolean primary key default true check (id),
  fecha_limite_cambios timestamptz
);
alter table public.ajustes enable row level security;
insert into public.ajustes (id, fecha_limite_cambios) values (true, null);

alter table public.rsvps
  add column invitacion_id uuid references public.invitaciones(id) on delete set null,
  add column asistentes smallint check (asistentes between 0 and 10),
  add column actualizado_en timestamptz;
-- Una sola respuesta por invitación (las respuestas antiguas sin código no cuentan)
create unique index rsvps_una_por_invitacion on public.rsvps (invitacion_id) where invitacion_id is not null;

-- Lo que ve un invitado con su código: su nombre, cupos y su respuesta si ya respondió.
create or replace function public.obtener_invitacion(p_codigo text)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  inv public.invitaciones;
  r public.rsvps;
  limite timestamptz;
begin
  select * into inv from public.invitaciones where codigo = lower(trim(p_codigo));
  if not found then
    return null;
  end if;
  select * into r from public.rsvps where invitacion_id = inv.id;
  select fecha_limite_cambios into limite from public.ajustes where id;
  return json_build_object(
    'nombre', inv.nombre,
    'cupos', inv.cupos,
    'puede_cambiar', limite is null or now() <= limite,
    'respuesta', case when r.id is null then null else json_build_object(
      'asiste', r.attending,
      'asistentes', r.asistentes,
      'diet', r.diet,
      'note', r.note
    ) end
  );
end;
$$;

-- Guarda o actualiza la respuesta de una invitación, respetando sus cupos.
create or replace function public.responder_invitacion(
  p_codigo text,
  p_asiste boolean,
  p_asistentes integer,
  p_diet text default null,
  p_note text default null
)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inv public.invitaciones;
  limite timestamptz;
  ya_respondio boolean;
  n smallint;
begin
  select * into inv from public.invitaciones where codigo = lower(trim(p_codigo));
  if not found then
    raise exception 'codigo_invalido' using errcode = 'P0001';
  end if;
  if p_asiste is null then
    raise exception 'falta_asistencia' using errcode = 'P0001';
  end if;

  select exists(select 1 from public.rsvps where invitacion_id = inv.id) into ya_respondio;
  select fecha_limite_cambios into limite from public.ajustes where id;
  if ya_respondio and limite is not null and now() > limite then
    raise exception 'fuera_de_plazo' using errcode = 'P0001';
  end if;

  if p_asiste then
    if p_asistentes is null or p_asistentes < 1 or p_asistentes > inv.cupos then
      raise exception 'asistentes_invalidos' using errcode = 'P0001';
    end if;
    n := p_asistentes;
  else
    n := 0;
  end if;

  insert into public.rsvps (name, attending, plus_one, asistentes, diet, note, invitacion_id)
  values (
    inv.nombre, p_asiste, n > 1, n,
    case when p_asiste then nullif(left(trim(coalesce(p_diet, '')), 300), '') end,
    nullif(left(trim(coalesce(p_note, '')), 1000), ''),
    inv.id
  )
  on conflict (invitacion_id) where invitacion_id is not null do update set
    attending = excluded.attending,
    plus_one = excluded.plus_one,
    asistentes = excluded.asistentes,
    diet = excluded.diet,
    note = excluded.note,
    actualizado_en = now();

  return public.obtener_invitacion(inv.codigo);
end;
$$;

revoke all on function public.nuevo_codigo() from public, anon, authenticated;
revoke all on function public.obtener_invitacion(text) from public;
revoke all on function public.responder_invitacion(text, boolean, integer, text, text) from public;
grant execute on function public.obtener_invitacion(text) to anon, authenticated;
grant execute on function public.responder_invitacion(text, boolean, integer, text, text) to anon, authenticated;
