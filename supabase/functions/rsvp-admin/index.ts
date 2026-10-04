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

    const [rsvpsRes, invRes, catRes, canRes] = await Promise.all([
      supabase
        .from("rsvps")
        .select("name, attending, plus_one, asistentes, diet, note, submitted_at, actualizado_en, invitacion_id")
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
    ]);

    if (rsvpsRes.error) return json({ error: rsvpsRes.error.message }, 500);
    if (invRes.error) return json({ error: invRes.error.message }, 500);
    if (catRes.error) return json({ error: catRes.error.message }, 500);
    if (canRes.error) return json({ error: canRes.error.message }, 500);

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
    });
  } catch (_e) {
    return json({ error: "bad request" }, 400);
  }
});
