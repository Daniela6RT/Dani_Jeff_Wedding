import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Búsqueda de canciones en Spotify para la sección de playlist.
// Las claves viven en los secretos SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET
// de Supabase (nunca en la página). Solo responde a códigos de invitación válidos.
const CLIENT_ID = Deno.env.get("SPOTIFY_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("SPOTIFY_CLIENT_SECRET") ?? "";

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

// Token de Spotify (client credentials), reutilizado mientras no venza
let token: { valor: string; vence: number } | null = null;
async function tokenSpotify(): Promise<string> {
  if (token && Date.now() < token.vence) return token.valor;
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(CLIENT_ID + ":" + CLIENT_SECRET),
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) throw new Error("token");
  const d = await resp.json();
  token = { valor: d.access_token, vence: Date.now() + (d.expires_in - 60) * 1000 };
  return token.valor;
}

type Imagen = { url: string; width: number | null };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const codigo = String(body?.codigo ?? "").trim().toLowerCase();
    const q = String(body?.q ?? "").trim();

    if (!/^[a-z0-9]{8}$/.test(codigo) || q.length < 2 || q.length > 100) {
      return json({ error: "bad request" }, 400);
    }
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return json({ error: "spotify_no_configurado" }, 503);
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: inv } = await supabase.from("invitaciones").select("id").eq("codigo", codigo).maybeSingle();
    if (!inv) return json({ error: "codigo_invalido" }, 403);

    const url = "https://api.spotify.com/v1/search?type=track&limit=5&market=CO&q=" + encodeURIComponent(q);
    let resp = await fetch(url, { headers: { Authorization: "Bearer " + (await tokenSpotify()) } });
    if (resp.status === 401) {
      token = null;
      resp = await fetch(url, { headers: { Authorization: "Bearer " + (await tokenSpotify()) } });
    }
    if (!resp.ok) return json({ error: "spotify" }, 502);

    const data = await resp.json();
    const canciones = (data?.tracks?.items ?? []).map((t: Record<string, any>) => {
      const imgs: Imagen[] = (t.album?.images ?? []).slice().sort((a: Imagen, b: Imagen) => (a.width ?? 0) - (b.width ?? 0));
      const portada = imgs.find((i) => (i.width ?? 0) >= 64) ?? imgs[imgs.length - 1];
      return {
        id: t.id,
        titulo: t.name,
        artista: (t.artists ?? []).map((a: { name: string }) => a.name).join(", "),
        url: t.external_urls?.spotify ?? null,
        portada: portada?.url ?? null,
      };
    });
    return json({ canciones });
  } catch (_e) {
    return json({ error: "bad request" }, 400);
  }
});
