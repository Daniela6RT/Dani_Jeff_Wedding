-- Alertas por correo: qué avisos urgentes ya se enviaron (para no repetirlos)
-- y una clave interna con la que el cron llama a la función alertas-boda.
create table public.alertas_enviadas (
  clave text primary key check (char_length(clave) <= 120),
  enviado_en timestamptz not null default now()
);
comment on table public.alertas_enviadas is 'Avisos urgentes ya enviados por correo. Solo funciones.';
alter table public.alertas_enviadas enable row level security;

create table public.config_privada (
  clave text primary key,
  valor text not null
);
comment on table public.config_privada is 'Valores internos (no secretos de terceros). Sin acceso público.';
alter table public.config_privada enable row level security;

-- El valor se genera dentro de la base; nunca queda en el repositorio
insert into public.config_privada (clave, valor)
values ('alertas_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (clave) do nothing;

-- Resumen por correo: lunes 7:00 a. m. (12:00 UTC lunes) y viernes 7:00 p. m. (00:00 UTC sábado), hora de Colombia
select cron.schedule('alertas-boda-lunes', '0 12 * * 1', $$
  select net.http_post(
    url := 'https://ejuwrotykcyuuofklvqc.supabase.co/functions/v1/alertas-boda',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-alertas-token', (select valor from public.config_privada where clave = 'alertas_token')),
    body := '{"modo":"semanal"}'::jsonb
  );
$$);
select cron.schedule('alertas-boda-viernes', '0 0 * * 6', $$
  select net.http_post(
    url := 'https://ejuwrotykcyuuofklvqc.supabase.co/functions/v1/alertas-boda',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-alertas-token', (select valor from public.config_privada where clave = 'alertas_token')),
    body := '{"modo":"semanal"}'::jsonb
  );
$$);
