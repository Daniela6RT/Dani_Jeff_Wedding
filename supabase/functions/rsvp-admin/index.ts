import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// La contraseña del panel vive en el secreto ADMIN_PASSWORD de Supabase
// (Edge Functions → Secrets), nunca en el código: este repo es público.
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";

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

    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
      // Pausa para frenar intentos repetidos de adivinar la contraseña
      await new Promise((r) => setTimeout(r, 1000));
      return json({ error: "unauthorized" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

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
      return json({ ok: true });
    }

    if (body?.accion === "borrar_proveedor") {
      if (!esId(body.id)) return json({ error: "proveedor inválido" }, 400);
      const { count } = await supabase.from("pagos").select("id", { count: "exact", head: true }).eq("proveedor_id", body.id);
      if (count) return json({ error: "tiene pagos registrados; no se puede borrar" }, 409);
      const { error } = await supabase.from("proveedores").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
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
      return json({ ok: true });
    }

    if (body?.accion === "borrar_cuota") {
      if (!esId(body.id)) return json({ error: "cuota inválida" }, 400);
      const { count } = await supabase.from("pagos").select("id", { count: "exact", head: true }).eq("plan_pago_id", body.id);
      if (count) return json({ error: "tiene pagos registrados; no se puede borrar" }, 409);
      const { error } = await supabase.from("plan_pagos").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // Cotizaciones: se comparan y, si se contratan, pasan a ser proveedores
    const TIPOS: Record<string, string> = {
      "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic",
    };
    const subirArchivo = async (a: unknown): Promise<string | null | { error: string }> => {
      if (!a || typeof a !== "object") return null;
      const { tipo, base64 } = a as { tipo?: string; base64?: string };
      const ext = tipo ? TIPOS[tipo] : undefined;
      if (!ext || typeof base64 !== "string") return { error: "el archivo debe ser PDF o imagen" };
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      if (bytes.length > 8 * 1024 * 1024) return { error: "el archivo pesa más de 8 MB" };
      const ruta = `${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from("cotizaciones").upload(ruta, bytes, { contentType: tipo });
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
      return json({ ok: true });
    }

    if (body?.accion === "estado_cotizacion") {
      if (!esId(body.id) || !["evaluacion", "descartada"].includes(body.estado)) return json({ error: "datos inválidos" }, 400);
      const { error } = await supabase.from("cotizaciones").update({ estado: body.estado, proveedor_id: null }).eq("id", body.id).neq("estado", "contratada");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body?.accion === "borrar_cotizacion") {
      if (!esId(body.id)) return json({ error: "cotización inválida" }, 400);
      const { data: c } = await supabase.from("cotizaciones").select("estado, archivo_path").eq("id", body.id).maybeSingle();
      if (!c) return json({ error: "cotización no encontrada" }, 404);
      if (c.estado === "contratada") return json({ error: "ya está contratada; no se puede borrar" }, 409);
      const { error } = await supabase.from("cotizaciones").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      if (c.archivo_path) await supabase.storage.from("cotizaciones").remove([c.archivo_path]);
      return json({ ok: true });
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
      return json({ ok: true, proveedorId: prov.id });
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
      return json({ ok: true });
    }

    if (body?.accion === "aplica_pendiente") {
      if (!esId(body.id)) return json({ error: "pendiente inválido" }, 400);
      const { error } = await supabase.from("pendientes").update({ no_aplica: body.no_aplica === true }).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body?.accion === "borrar_pendiente") {
      if (!esId(body.id)) return json({ error: "pendiente inválido" }, 400);
      const { error } = await supabase.from("pendientes").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    const [rsvpsRes, invRes, catRes, canRes, corteRes, perRes, provRes, planRes, pagRes, cotRes, penRes] = await Promise.all([
      supabase
        .from("rsvps")
        .select("name, attending, plus_one, asistentes, diet, note, submitted_at, actualizado_en, invitacion_id, lleva_carro, placa")
        .order("submitted_at", { ascending: false }),
      supabase
        .from("invitaciones")
        .select("id, codigo, nombre, categoria, cupos, notas, creada_en")
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
        .select("id, invitacion_id, nombre, rol, acompanante_de, orden, mesa, notas")
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
    });
  } catch (_e) {
    return json({ error: "bad request" }, 400);
  }
});
