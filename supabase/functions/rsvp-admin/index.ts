import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// La contraseña del panel vive en el secreto ADMIN_PASSWORD de Supabase
// (Edge Functions → Secrets), nunca en el código: este repo es público.
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";
// Correos con acceso al entrar con Google (secreto ADMIN_EMAILS, separados por coma)
const ADMIN_EMAILS = (Deno.env.get("ADMIN_EMAILS") ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const password = body?.password;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Acceso: sesión de Google de un correo permitido, o la contraseña (respaldo)
    let quien = "Alguien con la contraseña";
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      let email: string | null = null;
      if (token && !token.startsWith("sb_")) {
        const { data } = await supabase.auth.getUser(token);
        email = data.user?.email?.toLowerCase() ?? null;
        const meta = (data.user?.user_metadata ?? {}) as Record<string, string>;
        quien = String(meta.full_name || meta.name || email || "").split(" ")[0].slice(0, 80) || "Google";
      }
      if (!email) {
        // Pausa para frenar intentos repetidos de adivinar la contraseña
        await new Promise((r) => setTimeout(r, 1000));
        return json({ error: "unauthorized" }, 401);
      }
      if (!ADMIN_EMAILS.includes(email)) return json({ error: "forbidden" }, 403);
    }

    // Historial: cada cambio guardado queda registrado con quién lo hizo
    const esUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v);
    const cita = (t: unknown) => (t ? "“" + String(t).trim().slice(0, 80) + "”" : "");
    const plata = (n: unknown) => "$" + Math.round(Number(n) || 0).toLocaleString("es-CO");
    const campo = async (tabla: string, col: string, id: unknown) => {
      if (!esUuid(id)) return null;
      const { data } = await supabase.from(tabla).select(col).eq("id", id as string).maybeSingle();
      return (data as Record<string, unknown> | null)?.[col] ?? null;
    };
    const ESTADO_TAREA: Record<string, string> = { sin_empezar: "Por hacer", en_progreso: "En progreso", listo: "Lista" };
    const describir = async (b: Record<string, any>): Promise<string | null> => {
      const editar = esUuid(b.id);
      switch (b.accion) {
        case "editar_persona": return "Cambió el nombre de un invitado a " + (cita(b.nombre) || "“por definir”");
        case "marcar_recordado": {
          const { data } = await supabase.from("invitaciones").select("nombre").eq("codigo", String(b.codigo ?? "")).maybeSingle();
          return (b.recordado === true ? "Marcó como enviado el recordatorio a " : "Quitó la marca de recordatorio a ") + cita(data?.nombre);
        }
        case "guardar_proveedor": return (editar ? "Editó el proveedor " : "Creó el proveedor ") + cita(b.nombre);
        case "borrar_proveedor": return "Eliminó el proveedor " + cita(await campo("proveedores", "nombre", b.id));
        case "guardar_cuota": return (editar ? "Editó la cuota " : "Añadió la cuota ") + cita(b.concepto) + " (" + plata(b.monto) + ")";
        case "borrar_cuota": return "Eliminó la cuota " + cita(await campo("plan_pagos", "concepto", b.id));
        case "guardar_cotizacion": return (editar ? "Editó la cotización de " : "Añadió la cotización de ") + cita(b.nombre) + " por " + plata(b.monto);
        case "estado_cotizacion": return (b.estado === "descartada" ? "Descartó la cotización de " : "Volvió a evaluar la cotización de ") + cita(await campo("cotizaciones", "nombre", b.id));
        case "borrar_cotizacion": return "Eliminó la cotización de " + cita(await campo("cotizaciones", "nombre", b.id));
        case "contratar_cotizacion": return "Contrató a " + cita(await campo("cotizaciones", "nombre", b.id));
        case "guardar_pago": {
          const prov = editar ? await campo("proveedores", "nombre", await campo("pagos", "proveedor_id", b.id)) : await campo("proveedores", "nombre", b.proveedor_id);
          return (editar ? "Editó el pago de " : "Registró un pago de ") + plata(b.monto) + " a " + cita(prov);
        }
        case "borrar_pago": {
          const monto = await campo("pagos", "monto", b.id);
          const prov = await campo("proveedores", "nombre", await campo("pagos", "proveedor_id", b.id));
          return "Eliminó un pago de " + plata(monto) + " a " + cita(prov);
        }
        case "guardar_pendiente": return (editar ? "Editó el pendiente " : "Añadió a por contratar ") + cita(b.nombre);
        case "aplica_pendiente": return "Marcó " + cita(await campo("pendientes", "nombre", b.id)) + (b.no_aplica === true ? " como no aplica" : " como pendiente de nuevo");
        case "borrar_pendiente": return "Quitó de por contratar " + cita(await campo("pendientes", "nombre", b.id));
        case "guardar_tarea": return (editar ? "Editó la tarea " : "Creó la tarea ") + cita(b.titulo);
        case "estado_tarea": return "Movió la tarea " + cita(await campo("tareas", "titulo", b.id)) + " a " + (ESTADO_TAREA[b.estado] ?? b.estado);
        case "borrar_tarea": return "Eliminó la tarea " + cita(await campo("tareas", "titulo", b.id));
        case "guardar_momento": return (editar ? "Editó en el cronograma " : "Añadió al cronograma ") + cita(b.actividad);
        case "borrar_momento": return "Quitó del cronograma " + cita(await campo("cronograma", "actividad", b.id));
        case "guardar_kit":
          if (editar && typeof b.listo === "boolean") return "Marcó " + cita(await campo("kit", "item", b.id)) + (b.listo ? " del kit como listo" : " del kit como pendiente");
          return editar ? "Editó " + cita(b.item) + " del kit" : "Añadió al kit " + cita(b.item);
        case "borrar_kit": return "Quitó del kit " + cita(await campo("kit", "item", b.id));
        case "guardar_contacto": return (editar ? "Editó el contacto " : "Añadió el contacto ") + cita(b.rol);
        case "borrar_contacto": return "Eliminó el contacto " + cita(await campo("contactos", "rol", b.id));
        case "guardar_documento": return "Adjuntó " + cita(b.nombre) + " a " + cita(await campo("proveedores", "nombre", b.proveedor_id));
        case "borrar_documento": return "Eliminó el documento " + cita(await campo("documentos", "nombre", b.id));
        case "guardar_mesa": return (editar ? "Editó la mesa " : "Creó la mesa ") + cita(b.nombre);
        case "borrar_mesa": return "Eliminó la mesa " + cita(await campo("mesas", "nombre", b.id));
        case "asignar_mesa": {
          const persona = (await campo("personas", "nombre", b.persona_id)) ?? (await campo("mesa_extras", "nombre", b.persona_id));
          return esUuid(b.mesa_id) ? "Sentó a " + cita(persona) + " en " + cita(await campo("mesas", "nombre", b.mesa_id)) : "Quitó de su mesa a " + cita(persona);
        }
        default: return null;
      }
    };
    const detalle = typeof body?.accion === "string" ? await describir(body).catch(() => null) : null;
    const listo = async (extra: Record<string, unknown> = {}) => {
      if (detalle) await supabase.from("historial").insert({ quien, accion: String(body.accion).slice(0, 40), detalle: detalle.slice(0, 300) });
      return json({ ok: true, ...extra });
    };

    // Editar el nombre de una persona (p. ej. el +1 "por definir")
    if (body?.accion === "editar_persona") {
      const id = typeof body.id === "string" ? body.id : "";
      const nombre = typeof body.nombre === "string" ? body.nombre.trim().replace(/\s+/g, " ") : "";
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "persona inválida" }, 400);
      if (nombre.length > 80) return json({ error: "nombre muy largo" }, 400);
      const { data: p, error: e1 } = await supabase.from("personas").select("rol").eq("id", id).maybeSingle();
      if (e1) return json({ error: e1.message }, 500);
      if (!p) return json({ error: "persona no encontrada" }, 404);
      // Solo un acompañante puede volver a quedar "por definir"
      if (!nombre && p.rol !== "acompanante") return json({ error: "el nombre es obligatorio" }, 400);
      const { error: e2 } = await supabase.from("personas").update({ nombre: nombre || null }).eq("id", id);
      if (e2) return json({ error: e2.message }, 500);
      return await listo();
    }

    // Recordatorio por WhatsApp: el teléfono solo sale de aquí al abrir el chat
    if (body?.accion === "whatsapp_recordatorio") {
      const codigo = typeof body.codigo === "string" ? body.codigo : "";
      const { data: inv, error: e1 } = await supabase.from("invitaciones").select("id, telefono").eq("codigo", codigo).maybeSingle();
      if (e1) return json({ error: e1.message }, 500);
      if (!inv) return json({ error: "invitación no encontrada" }, 404);
      let digitos = String(inv.telefono ?? "").replace(/\D/g, "");
      if (digitos.length === 10) digitos = "57" + digitos;
      if (digitos.length < 11) return json({ error: "esta invitación no tiene teléfono" }, 400);
      const mensaje = typeof body.mensaje === "string" ? body.mensaje.slice(0, 1500) : "";
      // api.whatsapp.com directo: el redireccionamiento de wa.me daña algunos emojis
      return json({ url: "https://api.whatsapp.com/send?phone=" + digitos + (mensaje ? "&text=" + encodeURIComponent(mensaje) : "") });
    }

    // Marca (o quita) que el recordatorio sí se envió
    if (body?.accion === "marcar_recordado") {
      const codigo = typeof body.codigo === "string" ? body.codigo : "";
      const { error } = await supabase.from("invitaciones")
        .update({ recordado_en: body.recordado === true ? new Date().toISOString() : null }).eq("codigo", codigo);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    // Correo de prueba de las alertas (lo envía la función alertas-boda)
    if (body?.accion === "probar_alertas") {
      const { data: cfg } = await supabase.from("config_privada").select("valor").eq("clave", "alertas_token").maybeSingle();
      const r = await fetch(supabaseUrl + "/functions/v1/alertas-boda", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-alertas-token": cfg?.valor ?? "" },
        body: JSON.stringify({ prueba: true, modo: "semanal" }),
      });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: res.error || "no se pudo enviar el correo" }, 502);
      return json({ ok: true });
    }

    // Gestión: proveedores y su plan de pagos
    const texto = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "") || null;
    // Para notas: conserva los saltos de línea
    const textoLargo = (v: unknown, max: number) =>
      (typeof v === "string" ? v.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "") || null;
    const esId = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v);
    const pesos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e12 ? Math.round(v) : null);
    const esFecha = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));

    if (body?.accion === "guardar_proveedor") {
      const fila = {
        nombre: texto(body.nombre, 120),
        categoria: texto(body.categoria, 60),
        contacto: texto(body.contacto, 120),
        total: pesos(body.total),
        notas: textoLargo(body.notas, 1000),
        contrato: ["pendiente", "firmado", "no_aplica"].includes(body.contrato) ? body.contrato : "pendiente",
        contrato_fecha: body.contrato === "firmado" && esFecha(body.contrato_fecha) ? body.contrato_fecha : null,
      };
      if (!fila.nombre) return json({ error: "el nombre es obligatorio" }, 400);
      if (fila.total === null) return json({ error: "el total no es válido" }, 400);
      const q = esId(body.id)
        ? supabase.from("proveedores").update(fila).eq("id", body.id)
        : supabase.from("proveedores").insert(fila);
      const { error } = await q;
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    if (body?.accion === "borrar_proveedor") {
      if (!esId(body.id)) return json({ error: "proveedor inválido" }, 400);
      const { count } = await supabase.from("pagos").select("id", { count: "exact", head: true }).eq("proveedor_id", body.id);
      if (count) return json({ error: "tiene pagos registrados; no se puede borrar" }, 409);
      // Sus documentos se borran con él (filas en cascada; archivos aquí)
      const { data: docs } = await supabase.from("documentos").select("archivo_path").eq("proveedor_id", body.id);
      const { error } = await supabase.from("proveedores").delete().eq("id", body.id);
      if (!error && docs?.length) await supabase.storage.from("contratos").remove(docs.map((d) => d.archivo_path));
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    if (body?.accion === "guardar_cuota") {
      const monto = pesos(body.monto);
      const fila = {
        concepto: texto(body.concepto, 80),
        monto,
        fecha_limite: body.fecha_limite ? (esFecha(body.fecha_limite) ? body.fecha_limite : "x") : null,
      };
      if (!fila.concepto) return json({ error: "el concepto es obligatorio" }, 400);
      if (!monto) return json({ error: "el monto debe ser mayor que cero" }, 400);
      if (fila.fecha_limite === "x") return json({ error: "la fecha no es válida" }, 400);
      let q;
      if (esId(body.id)) {
        q = supabase.from("plan_pagos").update(fila).eq("id", body.id);
      } else {
        if (!esId(body.proveedor_id)) return json({ error: "proveedor inválido" }, 400);
        const { data: ult } = await supabase.from("plan_pagos").select("orden").eq("proveedor_id", body.proveedor_id)
          .order("orden", { ascending: false }).limit(1).maybeSingle();
        q = supabase.from("plan_pagos").insert({ ...fila, proveedor_id: body.proveedor_id, orden: (ult?.orden ?? 0) + 1 });
      }
      const { error } = await q;
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    if (body?.accion === "borrar_cuota") {
      if (!esId(body.id)) return json({ error: "cuota inválida" }, 400);
      const { count } = await supabase.from("pagos").select("id", { count: "exact", head: true }).eq("plan_pago_id", body.id);
      if (count) return json({ error: "tiene pagos registrados; no se puede borrar" }, 409);
      const { error } = await supabase.from("plan_pagos").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    // Cotizaciones: se comparan y, si se contratan, pasan a ser proveedores
    const TIPOS: Record<string, string> = {
      "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic",
    };
    const subirArchivo = async (a: unknown, bucket = "cotizaciones"): Promise<string | null | { error: string }> => {
      if (!a || typeof a !== "object") return null;
      const { tipo, base64 } = a as { tipo?: string; base64?: string };
      const ext = tipo ? TIPOS[tipo] : undefined;
      if (!ext || typeof base64 !== "string") return { error: "el archivo debe ser PDF o imagen" };
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      if (bytes.length > 8 * 1024 * 1024) return { error: "el archivo pesa más de 8 MB" };
      const ruta = `${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from(bucket).upload(ruta, bytes, { contentType: tipo });
      return error ? { error: error.message } : ruta;
    };

    if (body?.accion === "guardar_cotizacion") {
      const fila: Record<string, unknown> = {
        nombre: texto(body.nombre, 120),
        categoria: texto(body.categoria, 60),
        contacto: texto(body.contacto, 120),
        monto: pesos(body.monto),
        fecha: body.fecha ? (esFecha(body.fecha) ? body.fecha : "x") : null,
        notas: textoLargo(body.notas, 1000),
      };
      if (!fila.nombre) return json({ error: "el nombre es obligatorio" }, 400);
      if (fila.monto === null) return json({ error: "el valor no es válido" }, 400);
      if (fila.fecha === "x") return json({ error: "la fecha no es válida" }, 400);
      const anterior = esId(body.id)
        ? (await supabase.from("cotizaciones").select("archivo_path").eq("id", body.id).maybeSingle()).data
        : null;
      if (esId(body.id) && !anterior) return json({ error: "cotización no encontrada" }, 404);
      const subido = await subirArchivo(body.archivo);
      if (subido && typeof subido === "object") return json({ error: subido.error }, 400);
      if (subido) fila.archivo_path = subido;
      else if (body.quitar_archivo) fila.archivo_path = null;
      const { error } = esId(body.id)
        ? await supabase.from("cotizaciones").update(fila).eq("id", body.id)
        : await supabase.from("cotizaciones").insert(fila);
      if (error) return json({ error: error.message }, 500);
      // El archivo reemplazado o quitado se borra del bucket
      if (anterior?.archivo_path && (subido || body.quitar_archivo)) {
        await supabase.storage.from("cotizaciones").remove([anterior.archivo_path]);
      }
      return await listo();
    }

    if (body?.accion === "estado_cotizacion") {
      if (!esId(body.id) || !["evaluacion", "descartada"].includes(body.estado)) return json({ error: "datos inválidos" }, 400);
      const { error } = await supabase.from("cotizaciones").update({ estado: body.estado, proveedor_id: null }).eq("id", body.id).neq("estado", "contratada");
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    if (body?.accion === "borrar_cotizacion") {
      if (!esId(body.id)) return json({ error: "cotización inválida" }, 400);
      const { data: c } = await supabase.from("cotizaciones").select("estado, archivo_path").eq("id", body.id).maybeSingle();
      if (!c) return json({ error: "cotización no encontrada" }, 404);
      if (c.estado === "contratada") return json({ error: "ya está contratada; no se puede borrar" }, 409);
      const { error } = await supabase.from("cotizaciones").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      if (c.archivo_path) await supabase.storage.from("cotizaciones").remove([c.archivo_path]);
      return await listo();
    }

    if (body?.accion === "contratar_cotizacion") {
      if (!esId(body.id)) return json({ error: "cotización inválida" }, 400);
      const { data: c } = await supabase.from("cotizaciones").select("*").eq("id", body.id).maybeSingle();
      if (!c) return json({ error: "cotización no encontrada" }, 404);
      if (c.estado === "contratada") return json({ error: "ya está contratada" }, 409);
      const { data: prov, error: e1 } = await supabase.from("proveedores")
        .insert({ nombre: c.nombre, categoria: c.categoria, contacto: c.contacto, total: c.monto, notas: c.notas })
        .select("id").single();
      if (e1) return json({ error: e1.message }, 500);
      const { error: e2 } = await supabase.from("cotizaciones").update({ estado: "contratada", proveedor_id: prov.id }).eq("id", c.id);
      if (e2) return json({ error: e2.message }, 500);
      if (body.descartar_otras && c.categoria) {
        await supabase.from("cotizaciones").update({ estado: "descartada" })
          .eq("categoria", c.categoria).eq("estado", "evaluacion").neq("id", c.id);
      }
      return await listo({ proveedorId: prov.id });
    }

    // Pagos realizados, con su comprobante en el bucket privado
    if (body?.accion === "guardar_pago") {
      const fila: Record<string, unknown> = {
        monto: pesos(body.monto),
        fecha: esFecha(body.fecha) ? body.fecha : null,
        pagado_por: ["daniela", "jeferson", "ambos", "regalo"].includes(body.pagado_por) ? body.pagado_por : null,
        regalo_de: body.pagado_por === "regalo" ? texto(body.regalo_de, 80) : null,
        notas: textoLargo(body.notas, 1000),
      };
      if (!fila.monto) return json({ error: "el monto debe ser mayor que cero" }, 400);
      if (!fila.fecha) return json({ error: "la fecha no es válida" }, 400);
      if (!fila.pagado_por) return json({ error: "indica quién pagó" }, 400);
      if (fila.pagado_por === "regalo" && !fila.regalo_de) return json({ error: "indica de quién fue el regalo" }, 400);
      const anterior = esId(body.id)
        ? (await supabase.from("pagos").select("proveedor_id, comprobante_path").eq("id", body.id).maybeSingle()).data
        : null;
      if (esId(body.id) && !anterior) return json({ error: "pago no encontrado" }, 404);
      const proveedorId = anterior?.proveedor_id ?? body.proveedor_id;
      if (!esId(proveedorId)) return json({ error: "elige el proveedor" }, 400);
      if (!anterior) fila.proveedor_id = proveedorId;
      // La cuota debe ser del mismo proveedor
      if (body.plan_pago_id) {
        if (!esId(body.plan_pago_id)) return json({ error: "cuota inválida" }, 400);
        const { data: cuota } = await supabase.from("plan_pagos").select("proveedor_id").eq("id", body.plan_pago_id).maybeSingle();
        if (!cuota || cuota.proveedor_id !== proveedorId) return json({ error: "la cuota no es de ese proveedor" }, 400);
        fila.plan_pago_id = body.plan_pago_id;
      } else fila.plan_pago_id = null;
      const subido = await subirArchivo(body.archivo, "comprobantes");
      if (subido && typeof subido === "object") return json({ error: subido.error }, 400);
      if (subido) fila.comprobante_path = subido;
      else if (body.quitar_archivo) fila.comprobante_path = null;
      const { error } = anterior
        ? await supabase.from("pagos").update(fila).eq("id", body.id)
        : await supabase.from("pagos").insert(fila);
      if (error) return json({ error: error.message }, 500);
      if (anterior?.comprobante_path && (subido || body.quitar_archivo)) {
        await supabase.storage.from("comprobantes").remove([anterior.comprobante_path]);
      }
      return await listo();
    }

    if (body?.accion === "borrar_pago") {
      if (!esId(body.id)) return json({ error: "pago inválido" }, 400);
      const { data: pg } = await supabase.from("pagos").select("comprobante_path").eq("id", body.id).maybeSingle();
      if (!pg) return json({ error: "pago no encontrado" }, 404);
      const { error } = await supabase.from("pagos").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      if (pg.comprobante_path) await supabase.storage.from("comprobantes").remove([pg.comprobante_path]);
      return await listo();
    }

    // Documentos del proveedor (contrato firmado, anexos…), en el bucket privado "contratos"
    if (body?.accion === "guardar_documento") {
      const nombre = texto(body.nombre, 120);
      if (!esId(body.proveedor_id)) return json({ error: "proveedor inválido" }, 400);
      if (!nombre) return json({ error: "escribe el nombre del documento" }, 400);
      if (!body.archivo) return json({ error: "elige el archivo" }, 400);
      const subido = await subirArchivo(body.archivo, "contratos");
      if (!subido || typeof subido === "object") return json({ error: (subido as { error?: string } | null)?.error || "no se pudo subir el archivo" }, 400);
      const { error } = await supabase.from("documentos").insert({ proveedor_id: body.proveedor_id, nombre, archivo_path: subido });
      if (error) {
        await supabase.storage.from("contratos").remove([subido]);
        return json({ error: error.message }, 500);
      }
      return await listo();
    }

    if (body?.accion === "borrar_documento") {
      if (!esId(body.id)) return json({ error: "documento inválido" }, 400);
      const { data: doc } = await supabase.from("documentos").select("archivo_path").eq("id", body.id).maybeSingle();
      if (!doc) return json({ error: "documento no encontrado" }, 404);
      const { error } = await supabase.from("documentos").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      await supabase.storage.from("contratos").remove([doc.archivo_path]);
      return await listo();
    }

    // Lo que falta contratar
    if (body?.accion === "guardar_pendiente") {
      const fila: Record<string, unknown> = {
        nombre: texto(body.nombre, 120),
        categoria: texto(body.categoria, 60),
        estimado: body.estimado === null || body.estimado === undefined || body.estimado === "" ? null : pesos(body.estimado),
        notas: textoLargo(body.notas, 1000),
        no_aplica: body.no_aplica === true,
      };
      if (!fila.nombre) return json({ error: "el nombre es obligatorio" }, 400);
      if (!fila.categoria) return json({ error: "la categoría es obligatoria" }, 400);
      if (body.estimado != null && body.estimado !== "" && fila.estimado === null) return json({ error: "el estimado no es válido" }, 400);
      const { error } = esId(body.id)
        ? await supabase.from("pendientes").update(fila).eq("id", body.id)
        : await supabase.from("pendientes").insert(fila);
      if (error) {
        return json({ error: error.code === "23505" ? "ya existe un pendiente con esa categoría" : error.message }, error.code === "23505" ? 409 : 500);
      }
      return await listo();
    }

    if (body?.accion === "aplica_pendiente") {
      if (!esId(body.id)) return json({ error: "pendiente inválido" }, 400);
      const { error } = await supabase.from("pendientes").update({ no_aplica: body.no_aplica === true }).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    if (body?.accion === "borrar_pendiente") {
      if (!esId(body.id)) return json({ error: "pendiente inválido" }, 400);
      const { error } = await supabase.from("pendientes").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    // Tareas (checklist y trámites)
    const RESPONSABLES = ["daniela", "jeferson", "ambos", "familia"];
    const ESTADOS_TAREA = ["sin_empezar", "en_progreso", "listo"];
    if (body?.accion === "guardar_tarea") {
      const fase = Number(body.fase);
      const fila: Record<string, unknown> = {
        titulo: texto(body.titulo, 160),
        notas: textoLargo(body.notas, 1000),
        tipo: ["general", "civil", "finca"].includes(body.tipo) ? body.tipo : "general",
        fase: Number.isInteger(fase) && fase >= 1 && fase <= 5 ? fase : null,
        responsable: RESPONSABLES.includes(body.responsable) ? body.responsable : "ambos",
        estado: ESTADOS_TAREA.includes(body.estado) ? body.estado : "sin_empezar",
        prioridad: ["alta", "media", "baja"].includes(body.prioridad) ? body.prioridad : null,
        fecha_limite: esFecha(body.fecha_limite) ? body.fecha_limite : null,
        actualizada_en: new Date().toISOString(),
      };
      if (!fila.titulo) return json({ error: "escribe la tarea" }, 400);
      fila.completada_en = fila.estado === "listo" ? new Date().toISOString() : null;
      if (esId(body.id)) {
        // Conserva la fecha en que se completó si sigue lista
        const { data: previa } = await supabase.from("tareas").select("estado, completada_en").eq("id", body.id).maybeSingle();
        if (previa?.estado === "listo" && fila.estado === "listo") fila.completada_en = previa.completada_en;
      }
      const { error } = esId(body.id)
        ? await supabase.from("tareas").update(fila).eq("id", body.id)
        : await supabase.from("tareas").insert(fila);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    if (body?.accion === "estado_tarea") {
      if (!esId(body.id)) return json({ error: "tarea inválida" }, 400);
      if (!ESTADOS_TAREA.includes(body.estado)) return json({ error: "estado inválido" }, 400);
      const { error } = await supabase.from("tareas").update({
        estado: body.estado,
        completada_en: body.estado === "listo" ? new Date().toISOString() : null,
        actualizada_en: new Date().toISOString(),
      }).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    if (body?.accion === "borrar_tarea") {
      if (!esId(body.id)) return json({ error: "tarea inválida" }, 400);
      const { error } = await supabase.from("tareas").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    // Cronograma del día
    const esHora = (v: unknown) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    if (body?.accion === "guardar_momento") {
      const fila = {
        dia: esFecha(body.dia) ? body.dia : null,
        hora: esHora(body.hora) ? body.hora : null,
        hora_fin: esHora(body.hora_fin) ? body.hora_fin : null,
        actividad: texto(body.actividad, 160),
        responsable: texto(body.responsable, 60),
        ubicacion: texto(body.ubicacion, 120),
        cancion: texto(body.cancion, 160),
        notas: textoLargo(body.notas, 1000),
      };
      if (!fila.actividad) return json({ error: "escribe la actividad" }, 400);
      if (!fila.dia) return json({ error: "elige el día" }, 400);
      if (!fila.hora) return json({ error: "la hora no es válida" }, 400);
      const { error } = esId(body.id)
        ? await supabase.from("cronograma").update(fila).eq("id", body.id)
        : await supabase.from("cronograma").insert(fila);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    if (body?.accion === "borrar_momento") {
      if (!esId(body.id)) return json({ error: "momento inválido" }, 400);
      const { error } = await supabase.from("cronograma").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    // Kit de emergencia del día
    if (body?.accion === "guardar_kit") {
      const item = texto(body.item, 160);
      if (esId(body.id)) {
        const cambios: Record<string, unknown> = {};
        if (typeof body.listo === "boolean") cambios.listo = body.listo;
        if (item) cambios.item = item;
        const { error } = await supabase.from("kit").update(cambios).eq("id", body.id);
        if (error) return json({ error: error.message }, 500);
      } else {
        if (!item) return json({ error: "escribe el elemento" }, 400);
        const { error } = await supabase.from("kit").insert({ item });
        if (error) return json({ error: error.message }, 500);
      }
      return await listo();
    }

    if (body?.accion === "borrar_kit") {
      if (!esId(body.id)) return json({ error: "elemento inválido" }, 400);
      const { error } = await supabase.from("kit").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    // Contactos clave del día
    if (body?.accion === "guardar_contacto") {
      const fila = {
        rol: texto(body.rol, 80),
        nombre: texto(body.nombre, 120),
        telefono: texto(body.telefono, 40),
        notas: textoLargo(body.notas, 500),
      };
      if (!fila.rol) return json({ error: "escribe el rol" }, 400);
      if (esId(body.id)) {
        const { error } = await supabase.from("contactos").update(fila).eq("id", body.id);
        if (error) return json({ error: error.message }, 500);
      } else {
        const { data: ult } = await supabase.from("contactos").select("orden").order("orden", { ascending: false }).limit(1).maybeSingle();
        const { error } = await supabase.from("contactos").insert({ ...fila, orden: (ult?.orden ?? 0) + 1 });
        if (error) return json({ error: error.message }, 500);
      }
      return await listo();
    }

    if (body?.accion === "borrar_contacto") {
      if (!esId(body.id)) return json({ error: "contacto inválido" }, 400);
      const { error } = await supabase.from("contactos").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    // Mesas: crear/editar, borrar y sentar a una persona
    if (body?.accion === "guardar_mesa") {
      const capacidad = Number(body.capacidad);
      const fila = {
        nombre: texto(body.nombre, 60),
        capacidad: Number.isInteger(capacidad) && capacidad >= 1 && capacidad <= 40 ? capacidad : 8,
      };
      if (!fila.nombre) return json({ error: "escribe el nombre de la mesa" }, 400);
      if (esId(body.id)) {
        const { error } = await supabase.from("mesas").update(fila).eq("id", body.id);
        if (error) return json({ error: error.message }, 500);
      } else {
        const { data: ult } = await supabase.from("mesas").select("orden").order("orden", { ascending: false }).limit(1).maybeSingle();
        const { error } = await supabase.from("mesas").insert({ ...fila, orden: (ult?.orden ?? 0) + 1 });
        if (error) return json({ error: error.message }, 500);
      }
      return await listo();
    }

    if (body?.accion === "borrar_mesa") {
      if (!esId(body.id)) return json({ error: "mesa inválida" }, 400);
      const { error } = await supabase.from("mesas").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return await listo();
    }

    if (body?.accion === "asignar_mesa") {
      if (!esId(body.persona_id)) return json({ error: "persona inválida" }, 400);
      const mesaId = esId(body.mesa_id) ? body.mesa_id : null;
      // Puede ser un invitado (personas) o alguien de "otros en las mesas" (mesa_extras, p. ej. los novios)
      const { data: inv, error } = await supabase.from("personas").update({ mesa_id: mesaId }).eq("id", body.persona_id).select("id");
      if (error) return json({ error: error.message }, 500);
      if (!inv?.length) {
        const { error: e2 } = await supabase.from("mesa_extras").update({ mesa_id: mesaId }).eq("id", body.persona_id);
        if (e2) return json({ error: e2.message }, 500);
      }
      return await listo();
    }

    const [rsvpsRes, invRes, catRes, canRes, corteRes, perRes, provRes, planRes, pagRes, cotRes, penRes, tarRes, croRes, kitRes, conRes, mesRes, hisRes, docRes, extRes] = await Promise.all([
      supabase
        .from("rsvps")
        .select("name, attending, plus_one, asistentes, diet, note, submitted_at, actualizado_en, invitacion_id, lleva_carro, placa")
        .order("submitted_at", { ascending: false }),
      supabase
        .from("invitaciones")
        .select("id, codigo, nombre, categoria, cupos, notas, creada_en, telefono, recordado_en")
        .order("nombre", { ascending: true }),
      supabase.from("categorias").select("nombre, orden").order("orden", { ascending: true }),
      supabase
        .from("sugerencias_canciones")
        .select("titulo, artista, spotify_url, portada_url, creada_en, invitacion_id")
        .order("creada_en", { ascending: true }),
      supabase
        .from("corte")
        .select("nombre, rol, de_parte, acepto, respondido_en, invitacion_id, persona_id")
        .order("rol", { ascending: true })
        .order("nombre", { ascending: true }),
      supabase
        .from("personas")
        .select("id, invitacion_id, nombre, rol, acompanante_de, orden, mesa, mesa_id, notas")
        .order("orden", { ascending: true }),
      supabase.from("proveedores").select("id, nombre, categoria, contacto, total, notas, contrato, contrato_fecha").order("nombre", { ascending: true }),
      supabase.from("plan_pagos").select("id, proveedor_id, concepto, monto, fecha_limite, orden").order("orden", { ascending: true }),
      supabase
        .from("pagos")
        .select("id, proveedor_id, plan_pago_id, monto, fecha, pagado_por, regalo_de, comprobante_path, notas")
        .order("fecha", { ascending: false }),
      supabase
        .from("cotizaciones")
        .select("id, nombre, categoria, contacto, monto, fecha, notas, archivo_path, estado, proveedor_id, creada_en")
        .order("monto", { ascending: true }),
      supabase.from("pendientes").select("id, nombre, categoria, estimado, notas, no_aplica, orden").order("orden", { ascending: true }),
      supabase
        .from("tareas")
        .select("id, titulo, notas, tipo, fase, responsable, estado, prioridad, fecha_limite, completada_en")
        .order("fecha_limite", { ascending: true, nullsFirst: false })
        .order("creada_en", { ascending: true }),
      supabase
        .from("cronograma")
        .select("id, dia, hora, hora_fin, actividad, responsable, ubicacion, cancion, notas")
        .order("dia", { ascending: true })
        .order("hora", { ascending: true }),
      supabase.from("kit").select("id, item, listo").order("creado_en", { ascending: true }),
      supabase.from("contactos").select("id, rol, nombre, telefono, notas").order("orden", { ascending: true }),
      supabase.from("mesas").select("id, nombre, capacidad").order("orden", { ascending: true }),
      supabase.from("historial").select("quien, detalle, creado_en").order("creado_en", { ascending: false }).limit(60),
      supabase.from("documentos").select("id, proveedor_id, nombre, archivo_path, creado_en").order("creado_en", { ascending: true }),
      supabase.from("mesa_extras").select("id, nombre, etiqueta, mesa_id").order("orden", { ascending: true }),
    ]);

    if (rsvpsRes.error) return json({ error: rsvpsRes.error.message }, 500);
    if (invRes.error) return json({ error: invRes.error.message }, 500);
    if (catRes.error) return json({ error: catRes.error.message }, 500);
    if (canRes.error) return json({ error: canRes.error.message }, 500);
    if (corteRes.error) return json({ error: corteRes.error.message }, 500);
    if (perRes.error) return json({ error: perRes.error.message }, 500);
    if (provRes.error) return json({ error: provRes.error.message }, 500);
    if (planRes.error) return json({ error: planRes.error.message }, 500);
    if (pagRes.error) return json({ error: pagRes.error.message }, 500);
    if (cotRes.error) return json({ error: cotRes.error.message }, 500);
    if (penRes.error) return json({ error: penRes.error.message }, 500);
    if (tarRes.error) return json({ error: tarRes.error.message }, 500);
    if (croRes.error) return json({ error: croRes.error.message }, 500);
    if (kitRes.error) return json({ error: kitRes.error.message }, 500);
    if (conRes.error) return json({ error: conRes.error.message }, 500);
    if (mesRes.error) return json({ error: mesRes.error.message }, 500);
    if (hisRes.error) return json({ error: hisRes.error.message }, 500);
    if (docRes.error) return json({ error: docRes.error.message }, 500);
    if (extRes.error) return json({ error: extRes.error.message }, 500);
    // Enlaces temporales (1 hora) a los documentos de proveedores
    const docData = docRes.data ?? [];
    const firmadasDoc = new Map<string, string>();
    if (docData.length) {
      const { data: urls } = await supabase.storage.from("contratos").createSignedUrls(docData.map((d) => d.archivo_path), 3600);
      for (const u of urls ?? []) if (u.signedUrl && u.path) firmadasDoc.set(u.path, u.signedUrl);
    }

    const rsvps = rsvpsRes.data ?? [];
    const invs = invRes.data ?? [];
    const porInvitacion = new Map(rsvps.filter((r) => r.invitacion_id).map((r) => [r.invitacion_id, r]));

    const invitaciones = invs.map((i) => {
      const r = porInvitacion.get(i.id);
      return {
        codigo: i.codigo,
        nombre: i.nombre,
        categoria: i.categoria,
        cupos: i.cupos,
        notas: i.notas,
        tieneTelefono: !!i.telefono,
        recordadoEn: i.recordado_en,
        respuesta: r
          ? {
              asiste: r.attending,
              asistentes: r.asistentes ?? 0,
              diet: r.diet,
              note: r.note,
              carro: r.lleva_carro,
              placa: r.placa,
              fecha: r.actualizado_en ?? r.submitted_at,
            }
          : null,
      };
    });

    // Respuestas del formulario antiguo, sin invitación
    const antiguas = rsvps.filter((r) => !r.invitacion_id);
    const personasAntiguas = antiguas
      .filter((r) => r.attending)
      .reduce((n, r) => n + (r.plus_one ? 2 : 1), 0);

    const respondidas = invitaciones.filter((i) => i.respuesta);
    const resumen = {
      invitaciones: invitaciones.length,
      cupos: invitaciones.reduce((n, i) => n + i.cupos, 0),
      respondidas: respondidas.length,
      pendientes: invitaciones.length - respondidas.length,
      personasConfirmadas:
        respondidas.reduce((n, i) => n + (i.respuesta!.asiste ? i.respuesta!.asistentes : 0), 0) + personasAntiguas,
      invitacionesNoAsisten: respondidas.filter((i) => !i.respuesta!.asiste).length,
      respuestasSinInvitacion: antiguas.length,
      carros: respondidas.filter((i) => i.respuesta!.asiste && i.respuesta!.carro).length,
    };

    // Resumen por categoría (en el orden de la hoja DATOS); "Sin categoría" al final
    const nombresCat = [...(catRes.data ?? []).map((c) => c.nombre), null];
    const porCategoria = nombresCat
      .map((cat) => {
        const grupo = invitaciones.filter((i) => (i.categoria ?? null) === cat);
        const resp = grupo.filter((i) => i.respuesta);
        return {
          categoria: cat ?? "Sin categoría",
          invitaciones: grupo.length,
          cupos: grupo.reduce((n, i) => n + i.cupos, 0),
          personasConfirmadas: resp.reduce((n, i) => n + (i.respuesta!.asiste ? i.respuesta!.asistentes : 0), 0),
          pendientes: grupo.length - resp.length,
        };
      })
      .filter((c) => c.invitaciones > 0);

    // Canciones sugeridas: agrupadas por canción, las más pedidas primero
    const nombrePorId = new Map(invs.map((i) => [i.id, i.nombre]));
    const grupoCanciones = new Map<string, { titulo: string; artista: string; spotify_url: string | null; portada_url: string | null; quienes: string[] }>();
    for (const c of canRes.data ?? []) {
      const clave = (c.titulo + "|" + c.artista).toLowerCase();
      const g = grupoCanciones.get(clave) ?? { titulo: c.titulo, artista: c.artista, spotify_url: c.spotify_url, portada_url: c.portada_url, quienes: [] };
      g.spotify_url ??= c.spotify_url;
      g.portada_url ??= c.portada_url;
      g.quienes.push(nombrePorId.get(c.invitacion_id) ?? "—");
      grupoCanciones.set(clave, g);
    }
    const canciones = [...grupoCanciones.values()].sort((a, b) => b.quienes.length - a.quienes.length);

    // Corte de honor con el nombre de su invitación
    const corte = (corteRes.data ?? []).map((c) => ({
      nombre: c.nombre,
      rol: c.rol,
      de_parte: c.de_parte,
      acepto: c.acepto,
      respondido_en: c.respondido_en,
      invitacion: nombrePorId.get(c.invitacion_id) ?? "—",
    }));

    // Personas: cada invitado individual, con su invitación, rol y corte
    const perData = perRes.data ?? [];
    const nombrePersona = new Map(perData.map((p) => [p.id, p.nombre]));
    const cortePorPersona = new Map((corteRes.data ?? []).map((c: Record<string, any>) => [c.persona_id, c.rol]));
    const invPorId = new Map(invs.map((i) => [i.id, i]));
    const personas = perData.map((p) => {
      const inv = invPorId.get(p.invitacion_id);
      const r = porInvitacion.get(p.invitacion_id);
      return {
        id: p.id,
        nombre: p.nombre,
        rol: p.rol,
        acompananteDe: p.acompanante_de ? (nombrePersona.get(p.acompanante_de) ?? null) : null,
        invitacion: inv?.nombre ?? "—",
        categoria: inv?.categoria ?? null,
        corte: cortePorPersona.get(p.id) ?? null,
        mesa: p.mesa,
        mesaId: p.mesa_id,
        notas: p.notas,
        estadoInvitacion: !r ? "pendiente" : r.attending ? "asiste" : "no asiste",
      };
    });

    // Pagos y proveedores (mismas reglas que las vistas v_plan_pagos_estado y v_aportes)
    const pagosData = (pagRes.data ?? []).map((p) => ({ ...p, monto: Number(p.monto) }));
    const planData = planRes.data ?? [];
    const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
    const sumar = (lista: { monto: number }[]) => lista.reduce((n, x) => n + x.monto, 0);
    const plan = planData.map((pp) => {
      const suyos = pagosData.filter((pg) => pg.plan_pago_id === pp.id);
      const pagado = sumar(suyos);
      const monto = Number(pp.monto);
      return {
        id: pp.id,
        proveedorId: pp.proveedor_id,
        concepto: pp.concepto,
        monto,
        fechaLimite: pp.fecha_limite,
        pagado,
        saldo: monto - pagado,
        estado: pagado >= monto ? "pagado" : pp.fecha_limite && pp.fecha_limite < hoy ? "vencido" : pagado > 0 ? "parcial" : "pendiente",
      };
    });
    const proveedores = (provRes.data ?? []).map((pv) => {
      const pagado = sumar(pagosData.filter((pg) => pg.proveedor_id === pv.id));
      const total = Number(pv.total);
      return {
        id: pv.id, nombre: pv.nombre, categoria: pv.categoria, contacto: pv.contacto, notas: pv.notas, total, pagado, saldo: total - pagado,
        contrato: pv.contrato, contratoFecha: pv.contrato_fecha,
        documentos: docData.filter((d) => d.proveedor_id === pv.id).map((d) => ({
          id: d.id, nombre: d.nombre, url: firmadasDoc.get(d.archivo_path) ?? null,
          tipo: d.archivo_path.endsWith(".pdf") ? "pdf" : "imagen", fecha: d.creado_en,
        })),
      };
    });
    // Enlaces temporales (1 hora) a los comprobantes del bucket privado
    const rutas = pagosData.map((p) => p.comprobante_path).filter(Boolean) as string[];
    const firmadas = new Map<string, string>();
    if (rutas.length) {
      const { data: urls } = await supabase.storage.from("comprobantes").createSignedUrls(rutas, 3600);
      for (const u of urls ?? []) if (u.signedUrl && u.path) firmadas.set(u.path, u.signedUrl);
    }
    const provPorId = new Map(proveedores.map((p) => [p.id, p.nombre]));
    const planPorId = new Map(plan.map((p) => [p.id, p.concepto]));
    const aporte = (quien: string) =>
      pagosData.reduce((n, p) => n + (p.pagado_por === quien ? p.monto : p.pagado_por === "ambos" ? p.monto / 2 : 0), 0);
    const regalos = new Map<string, number>();
    for (const p of pagosData.filter((p) => p.pagado_por === "regalo")) {
      regalos.set(p.regalo_de ?? "—", (regalos.get(p.regalo_de ?? "—") ?? 0) + p.monto);
    }
    const cotData = cotRes.data ?? [];
    const rutasCot = cotData.map((c) => c.archivo_path).filter(Boolean) as string[];
    const firmadasCot = new Map<string, string>();
    if (rutasCot.length) {
      const { data: urls } = await supabase.storage.from("cotizaciones").createSignedUrls(rutasCot, 3600);
      for (const u of urls ?? []) if (u.signedUrl && u.path) firmadasCot.set(u.path, u.signedUrl);
    }
    const cotizaciones = cotData.map((c) => ({
      id: c.id,
      nombre: c.nombre,
      categoria: c.categoria,
      contacto: c.contacto,
      monto: Number(c.monto),
      fecha: c.fecha,
      notas: c.notas,
      estado: c.estado,
      proveedorId: c.proveedor_id,
      archivo: c.archivo_path ? (firmadasCot.get(c.archivo_path) ?? null) : null,
      archivoTipo: c.archivo_path ? (c.archivo_path.endsWith(".pdf") ? "pdf" : "imagen") : null,
    }));
    // Estado de cada pendiente según su categoría
    const misma = (a: string | null, b: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
    const pendientes = (penRes.data ?? []).map((p) => {
      const provs = proveedores.filter((pv) => misma(pv.categoria, p.categoria));
      const enEval = cotizaciones.filter((c) => c.estado === "evaluacion" && misma(c.categoria, p.categoria));
      return {
        id: p.id,
        nombre: p.nombre,
        categoria: p.categoria,
        estimado: p.estimado === null ? null : Number(p.estimado),
        notas: p.notas,
        noAplica: p.no_aplica,
        estado: p.no_aplica ? "no_aplica" : provs.length ? "contratado" : enEval.length ? "cotizando" : "por_cotizar",
        proveedores: provs.map((pv) => pv.nombre),
        cotizaciones: enEval.length,
        desde: enEval.length ? Math.min(...enEval.map((c) => c.monto)) : null,
      };
    });
    const finanzas = {
      pendientes,
      cotizaciones,
      resumen: {
        presupuesto: sumar(proveedores.map((p) => ({ monto: p.total }))),
        pagado: sumar(pagosData),
        aportes: [
          { quien: "Daniela", total: aporte("daniela") },
          { quien: "Jeferson", total: aporte("jeferson") },
          ...[...regalos].map(([de, total]) => ({ quien: de, total, regalo: true })),
        ],
      },
      proveedores,
      plan,
      pagos: pagosData.map((p) => ({
        id: p.id,
        proveedorId: p.proveedor_id,
        planPagoId: p.plan_pago_id,
        proveedor: provPorId.get(p.proveedor_id) ?? "—",
        concepto: p.plan_pago_id ? (planPorId.get(p.plan_pago_id) ?? null) : null,
        monto: p.monto,
        fecha: p.fecha,
        pagadoPor: p.pagado_por,
        regaloDe: p.regalo_de,
        notas: p.notas,
        comprobante: p.comprobante_path ? (firmadas.get(p.comprobante_path) ?? null) : null,
      })),
    };

    // Compatibilidad con el panel anterior (página publicada hoy)
    const confirmed = rsvps.filter((r) => r.attending).length;
    const plusOnes = rsvps.filter((r) => r.attending && r.plus_one).length;
    const declined = rsvps.filter((r) => !r.attending).length;
    const filaSimple = ({ name, attending, plus_one, diet, note, submitted_at }: Record<string, unknown>) => ({
      name, attending, plus_one, diet, note, submitted_at,
    });

    return json({
      rows: rsvps.map(filaSimple),
      summary: { confirmed, plusOnes, declined },
      invitaciones,
      antiguas: antiguas.map(filaSimple),
      resumen,
      porCategoria,
      canciones,
      corte,
      personas,
      finanzas,
      tareas: (tarRes.data ?? []).map((t) => ({
        id: t.id,
        titulo: t.titulo,
        notas: t.notas,
        tipo: t.tipo,
        fase: t.fase,
        responsable: t.responsable,
        estado: t.estado,
        prioridad: t.prioridad,
        fechaLimite: t.fecha_limite,
        completadaEn: t.completada_en,
      })),
      cronograma: (croRes.data ?? []).map((m) => ({
        id: m.id,
        dia: m.dia,
        hora: String(m.hora).slice(0, 5),
        horaFin: m.hora_fin ? String(m.hora_fin).slice(0, 5) : null,
        actividad: m.actividad,
        responsable: m.responsable,
        ubicacion: m.ubicacion,
        cancion: m.cancion,
        notas: m.notas,
      })),
      kit: kitRes.data ?? [],
      contactos: conRes.data ?? [],
      mesas: mesRes.data ?? [],
      historial: hisRes.data ?? [],
      mesaExtras: (extRes.data ?? []).map((x) => ({ id: x.id, nombre: x.nombre, etiqueta: x.etiqueta, mesaId: x.mesa_id })),
    });
  } catch (_e) {
    return json({ error: "bad request" }, 400);
  }
});
