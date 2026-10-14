import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Alertas por correo: resumen (lunes 7 a. m. y viernes 7 p. m. por cron) con lo urgente
// (pagos que vencen, tareas vencidas) y lo que se viene. También lo llama el panel
// ("Enviar resumen de prueba"). El modo "urgentes" queda disponible si se quiere un aviso diario.
// La clave de Resend vive en el secreto RESEND_API_KEY; los destinatarios en
// ALERTAS_PARA (o, si no existe, en ADMIN_EMAILS).
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const PARA = (Deno.env.get("ALERTAS_PARA") || Deno.env.get("ADMIN_EMAILS") || "")
  .split(",").map((e) => e.trim()).filter(Boolean);
const DE = Deno.env.get("ALERTAS_DE") || "Boda Dani & Jeff <onboarding@resend.dev>";
const PANEL = "https://boda-dani-jeff.vercel.app/admin.html";
const BODA = "2027-03-20";
const CIERRE_RSVP = "2027-01-15";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const esc = (t: unknown) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const pesos = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");
const fecha = (f: string) =>
  new Date(f + "T12:00:00").toLocaleDateString("es-CO", { weekday: "short", day: "numeric", month: "short" }).replace(/\./g, "");

Deno.serve(async (req: Request) => {
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Solo el cron o el panel (que conocen la clave interna) pueden pedir un envío
    const { data: cfg } = await supabase.from("config_privada").select("valor").eq("clave", "alertas_token").maybeSingle();
    if (!cfg?.valor || req.headers.get("x-alertas-token") !== cfg.valor) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const prueba = body?.prueba === true;
    const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
    const esLunes = new Date(hoy + "T12:00:00").getDay() === 1;
    const modo = body?.modo === "semanal" || body?.modo === "urgentes" ? body.modo : (esLunes ? "semanal" : "urgentes");
    const dias = (f: string) => Math.round((Date.parse(f) - Date.parse(hoy)) / 864e5);

    const [planRes, pagRes, provRes, tarRes, invRes, rsvRes, envRes] = await Promise.all([
      supabase.from("plan_pagos").select("id, proveedor_id, concepto, monto, fecha_limite"),
      supabase.from("pagos").select("plan_pago_id, monto"),
      supabase.from("proveedores").select("id, nombre, contrato"),
      supabase.from("tareas").select("id, titulo, estado, prioridad, responsable, fecha_limite").neq("estado", "listo"),
      supabase.from("invitaciones").select("id, cupos"),
      supabase.from("rsvps").select("invitacion_id, attending, asistentes"),
      supabase.from("alertas_enviadas").select("clave"),
    ]);
    for (const r of [planRes, pagRes, provRes, tarRes, invRes, rsvRes, envRes]) if (r.error) return json({ error: r.error.message }, 500);

    const provNombre = new Map((provRes.data ?? []).map((p) => [p.id, p.nombre]));
    const pagadoPorCuota = new Map<string, number>();
    for (const p of pagRes.data ?? []) if (p.plan_pago_id) pagadoPorCuota.set(p.plan_pago_id, (pagadoPorCuota.get(p.plan_pago_id) ?? 0) + Number(p.monto));
    const cuotas = (planRes.data ?? [])
      .map((c) => ({ ...c, saldo: Number(c.monto) - (pagadoPorCuota.get(c.id) ?? 0), proveedor: provNombre.get(c.proveedor_id) ?? "—" }))
      .filter((c) => c.saldo > 0)
      .sort((a, b) => (a.fecha_limite ?? "9999").localeCompare(b.fecha_limite ?? "9999"));
    const tareas = (tarRes.data ?? []).sort((a, b) => (a.fecha_limite ?? "9999").localeCompare(b.fecha_limite ?? "9999"));
    const nombreResp: Record<string, string> = { daniela: "Daniela", jeferson: "Jeferson", ambos: "Ambos", familia: "Familia" };

    // Urgente: pagos que vencen en 3 días o menos (o ya vencidos) y tareas vencidas o que vencen hoy/mañana
    type Aviso = { clave: string; html: string };
    const urgentes: Aviso[] = [];
    for (const c of cuotas) {
      if (!c.fecha_limite) continue;
      const d = dias(c.fecha_limite);
      if (d > 3) continue;
      urgentes.push({
        clave: "pago:" + c.id + ":" + (d < 0 ? "vencido" : c.fecha_limite),
        html: "💸 <b>" + esc(c.proveedor) + "</b> · " + esc(c.concepto) + " · <b>" + pesos(c.saldo) + "</b> — " +
          (d < 0 ? "<span style='color:#8E2F1A'>venció el " + fecha(c.fecha_limite) + "</span>" : d === 0 ? "vence <b>hoy</b>" : "vence en " + d + (d === 1 ? " día" : " días") + " (" + fecha(c.fecha_limite) + ")"),
      });
    }
    for (const t of tareas) {
      if (!t.fecha_limite) continue;
      const d = dias(t.fecha_limite);
      if (d > 1) continue;
      urgentes.push({
        clave: "tarea:" + t.id + ":" + (d < 0 ? "vencida" : "pronto") + ":" + t.fecha_limite,
        html: "⏰ <b>" + esc(t.titulo) + "</b> (" + esc(nombreResp[t.responsable] ?? t.responsable) + ") — " +
          (d < 0 ? "<span style='color:#8E2F1A'>venció el " + fecha(t.fecha_limite) + "</span>" : d === 0 ? "vence <b>hoy</b>" : "vence <b>mañana</b>"),
      });
    }
    const yaEnviadas = new Set((envRes.data ?? []).map((e) => e.clave));
    const nuevos = urgentes.filter((u) => !yaEnviadas.has(u.clave));

    if (modo === "urgentes" && !nuevos.length && !prueba) return json({ ok: true, enviado: false, motivo: "nada urgente nuevo" });

    // Contenido del correo
    const seccion = (titulo: string, filas: string[], vacio?: string) =>
      filas.length || vacio
        ? "<h3 style='font:600 15px Georgia,serif;color:#3D4A2C;margin:22px 0 8px'>" + titulo + "</h3>" +
          (filas.length ? "<ul style='margin:0;padding-left:18px;color:#4A3B35;font:14px/1.6 Arial,sans-serif'>" + filas.map((f) => "<li style='margin:4px 0'>" + f + "</li>").join("") + "</ul>"
            : "<p style='margin:0;color:#7A6F68;font:14px Arial,sans-serif'>" + vacio + "</p>")
        : "";
    const faltan = dias(BODA);
    let cuerpo = "";
    let asunto = "";
    if (modo === "urgentes") {
      asunto = "⚠️ Boda: " + nuevos.length + (nuevos.length === 1 ? " aviso urgente" : " avisos urgentes");
      cuerpo = seccion("⚠️ Requiere atención", (nuevos.length ? nuevos : urgentes).map((u) => u.html), "Nada urgente por ahora.");
    } else {
      asunto = "💍 Resumen de la boda · faltan " + faltan + " días";
      const pagosPronto = cuotas.filter((c) => c.fecha_limite && dias(c.fecha_limite) > 3 && dias(c.fecha_limite) <= 30)
        .map((c) => "<b>" + esc(c.proveedor) + "</b> · " + esc(c.concepto) + " · " + pesos(c.saldo) + " — " + fecha(c.fecha_limite!));
      const tareasSemana = tareas.filter((t) => t.fecha_limite && dias(t.fecha_limite) > 1 && dias(t.fecha_limite) <= 14)
        .map((t) => (t.prioridad === "alta" ? "↑ " : "") + "<b>" + esc(t.titulo) + "</b> (" + esc(nombreResp[t.responsable] ?? t.responsable) + ") — " + fecha(t.fecha_limite!));
      const altasSinFecha = tareas.filter((t) => !t.fecha_limite && t.prioridad === "alta").map((t) => "↑ " + esc(t.titulo));
      const sinFirmar = (provRes.data ?? []).filter((p) => p.contrato === "pendiente").map((p) => esc(p.nombre));
      const invs = invRes.data ?? [];
      const rsvps = (rsvRes.data ?? []).filter((r) => r.invitacion_id);
      const confirmados = rsvps.reduce((n, r) => n + (r.attending ? Number(r.asistentes ?? 0) : 0), 0);
      const cupos = invs.reduce((n, i) => n + Number(i.cupos ?? 0), 0);
      const sinResponder = invs.length - new Set(rsvps.map((r) => r.invitacion_id)).size;
      const diasRsvp = dias(CIERRE_RSVP);
      cuerpo =
        seccion("⚠️ Requiere atención", urgentes.map((u) => u.html), "Nada urgente esta semana. 🎉") +
        seccion("📅 Pagos de los próximos 30 días", pagosPronto) +
        seccion("📋 Tareas de las próximas 2 semanas", tareasSemana) +
        seccion("📌 Prioridad alta sin fecha", altasSinFecha) +
        seccion("📝 Contratos sin firmar", sinFirmar) +
        seccion("💌 Confirmaciones", [
          "<b>" + confirmados + "</b> personas confirmadas de " + cupos + " cupos",
          sinResponder + (sinResponder === 1 ? " invitación sin responder" : " invitaciones sin responder") +
            (diasRsvp >= 0 ? " · el RSVP cierra en " + diasRsvp + (diasRsvp === 1 ? " día" : " días") : " · el RSVP ya cerró"),
        ]);
    }
    if (prueba) asunto = "[Prueba] " + asunto;
    const html =
      "<div style='background:#F7F3EC;padding:24px 12px'><div style='max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E6DED2'>" +
      "<div style='background:#3D4A2C;color:#F8F5EE;padding:20px 24px'><div style='font:22px Georgia,serif'>Daniela &amp; Jeferson</div>" +
      "<div style='font:13px Arial,sans-serif;opacity:.85;margin-top:4px'>" + (faltan > 0 ? "Faltan " + faltan + " días · 20 de marzo de 2027" : "20 de marzo de 2027") + "</div></div>" +
      "<div style='padding:4px 24px 24px'>" + cuerpo +
      "<p style='margin:26px 0 0'><a href='" + PANEL + "' style='display:inline-block;background:#A0452A;color:#fff;text-decoration:none;font:600 14px Arial,sans-serif;padding:11px 20px;border-radius:30px'>Abrir el panel</a></p>" +
      "</div></div><p style='text-align:center;color:#9A8F87;font:11px Arial,sans-serif;margin-top:12px'>Correo automático del panel de la boda.</p></div>";

    if (!RESEND_API_KEY) return json({ error: "falta el secreto RESEND_API_KEY en Supabase" }, 500);
    if (!PARA.length) return json({ error: "no hay destinatarios (ALERTAS_PARA o ADMIN_EMAILS)" }, 500);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: DE, to: PARA, subject: asunto, html }),
    });
    if (!r.ok) return json({ error: "Resend respondió " + r.status + ": " + (await r.text()).slice(0, 300) }, 502);

    // Los avisos urgentes enviados no se repiten (salvo en los correos de prueba)
    if (!prueba && urgentes.length) {
      const claves = (modo === "urgentes" ? nuevos : urgentes).map((u) => ({ clave: u.clave }));
      await supabase.from("alertas_enviadas").upsert(claves, { onConflict: "clave", ignoreDuplicates: true });
    }
    return json({ ok: true, enviado: true, modo, para: PARA.length });
  } catch (_e) {
    return json({ error: "error inesperado" }, 500);
  }
});
