-- Corte de honor: personas de una invitación a quienes se les pregunta
-- "¿Aceptas ser mi dama / caballero de honor?" y su respuesta.
-- Aplicada en el proyecto ejuwrotykcyuuofklvqc el 2026-10-04.
create table public.corte (
  id uuid primary key default gen_random_uuid(),
  invitacion_id uuid not null references public.invitaciones(id) on delete cascade,
  nombre text not null check (char_length(nombre) between 1 and 60),
  rol text not null check (rol in ('dama', 'caballero')),
  de_parte text not null check (de_parte in ('novia', 'novio')),
  acepto boolean,
  respondido_en timestamptz,
  creado_en timestamptz not null default now(),
  unique (invitacion_id, nombre)
);
alter table public.corte enable row level security;
comment on table public.corte is 'Damas y caballeros de honor. Solo se lee/responde con el código de la invitación.';

-- obtener_invitacion devuelve también la corte de esa invitación
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
    ) end,
    'corte', coalesce((
      select json_agg(json_build_object('id', c.id, 'nombre', c.nombre, 'rol', c.rol, 'de_parte', c.de_parte, 'acepto', c.acepto) order by c.creado_en)
      from public.corte c where c.invitacion_id = inv.id
    ), '[]'::json)
  );
end;
$$;

-- Guardar la respuesta a la propuesta
create or replace function public.responder_corte(p_codigo text, p_id uuid, p_acepta boolean)
returns json
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_acepta is null then
    raise exception 'falta_respuesta' using errcode = 'P0001';
  end if;
  update public.corte c set acepto = p_acepta, respondido_en = now()
  from public.invitaciones i
  where c.id = p_id and i.id = c.invitacion_id and i.codigo = lower(trim(p_codigo));
  if not found then
    raise exception 'no_encontrado' using errcode = 'P0001';
  end if;
  return public.obtener_invitacion(p_codigo);
end;
$$;

revoke all on function public.responder_corte(text, uuid, boolean) from public;
grant execute on function public.responder_corte(text, uuid, boolean) to anon, authenticated;
