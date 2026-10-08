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

    const [rsvpsRes, invRes, catRes, canRes, corteRes, perRes] = await Promise.all([
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
    ]);

    if (rsvpsRes.error) return json({ error: rsvpsRes.error.message }, 500);
    if (invRes.error) return json({ error: invRes.error.message }, 500);
    if (catRes.error) return json({ error: catRes.error.message }, 500);
    if (canRes.error) return json({ error: canRes.error.message }, 500);
    if (corteRes.error) return json({ error: corteRes.error.message }, 500);
    if (perRes.error) return json({ error: perRes.error.message }, 500);

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
    });
  } catch (_e) {
    return json({ error: "bad request" }, 400);
  }
});
