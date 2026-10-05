-- ¿Vienen en carro? y placa, para autorizar el ingreso al parqueadero de la finca.
-- Aplicada en el proyecto ejuwrotykcyuuofklvqc el 2026-10-04.
alter table public.rsvps
  add column lleva_carro boolean,
  add column placa text check (placa ~ '^[A-Z0-9]{5,7}$');

-- Se reemplaza responder_invitacion con dos parámetros nuevos opcionales.
-- (Mismos nombres de parámetros: las llamadas anteriores siguen funcionando.)
drop function public.responder_invitacion(text, boolean, integer, text, text);

create function public.responder_invitacion(
  p_codigo text,
  p_asiste boolean,
  p_asistentes integer,
  p_diet text default null,
  p_note text default null,
  p_carro boolean default null,
  p_placa text default null
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
  placa_limpia text;
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

  -- Placa: mayúsculas, sin espacios ni guiones; solo si vienen y traen carro
  placa_limpia := nullif(upper(regexp_replace(coalesce(p_placa, ''), '[^A-Za-z0-9]', '', 'g')), '');
  if not coalesce(p_asiste and p_carro, false) then
    placa_limpia := null;
  elsif placa_limpia is not null and placa_limpia !~ '^[A-Z0-9]{5,7}$' then
    raise exception 'placa_invalida' using errcode = 'P0001';
  end if;

  insert into public.rsvps (name, attending, plus_one, asistentes, diet, note, invitacion_id, lleva_carro, placa)
  values (
    inv.nombre, p_asiste, n > 1, n,
    case when p_asiste then nullif(left(trim(coalesce(p_diet, '')), 300), '') end,
    nullif(left(trim(coalesce(p_note, '')), 1000), ''),
    inv.id,
    case when p_asiste then p_carro end,
    placa_limpia
  )
  on conflict (invitacion_id) where invitacion_id is not null do update set
    attending = excluded.attending,
    plus_one = excluded.plus_one,
    asistentes = excluded.asistentes,
    diet = excluded.diet,
    note = excluded.note,
    lleva_carro = excluded.lleva_carro,
    placa = excluded.placa,
    actualizado_en = now();

  return public.obtener_invitacion(inv.codigo);
end;
$$;

revoke all on function public.responder_invitacion(text, boolean, integer, text, text, boolean, text) from public;
grant execute on function public.responder_invitacion(text, boolean, integer, text, text, boolean, text) to anon, authenticated;

-- obtener_invitacion devuelve también carro y placa (para precargar el formulario)
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
      'note', r.note,
      'carro', r.lleva_carro,
      'placa', r.placa
    ) end
  );
end;
$$;
