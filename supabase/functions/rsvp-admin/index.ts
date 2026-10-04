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

    const [rsvpsRes, invRes] = await Promise.all([
      supabase
        .from("rsvps")
        .select("name, attending, plus_one, asistentes, diet, note, submitted_at, actualizado_en, invitacion_id")
        .order("submitted_at", { ascending: false }),
      supabase
        .from("invitaciones")
        .select("id, codigo, nombre, cupos, notas, creada_en")
        .order("nombre", { ascending: true }),
    ]);

    if (rsvpsRes.error) return json({ error: rsvpsRes.error.message }, 500);
    if (invRes.error) return json({ error: invRes.error.message }, 500);

    const rsvps = rsvpsRes.data ?? [];
    const invs = invRes.data ?? [];
    const porInvitacion = new Map(rsvps.filter((r) => r.invitacion_id).map((r) => [r.invitacion_id, r]));

    const invitaciones = invs.map((i) => {
      const r = porInvitacion.get(i.id);
      return {
        codigo: i.codigo,
        nombre: i.nombre,
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
    });
  } catch (_e) {
    return json({ error: "bad request" }, 400);
  }
});
