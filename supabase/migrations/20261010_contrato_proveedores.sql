-- Estado del contrato de cada proveedor: un proveedor puede estar
-- contratado (aceptamos su cotización) sin haber firmado todavía.
alter table public.proveedores
  add column contrato text not null default 'pendiente'
    check (contrato in ('pendiente', 'firmado', 'no_aplica')),
  add column contrato_fecha date;
