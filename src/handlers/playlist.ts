import { listLiveCatalog, listMatchStreams } from "../api/damitv.js";
import type { Match, StreamLink } from "../types/models.js";

const ttlMs = 15_000;
const cache = new Map<string, { at: number; body: string; count: number }>();

function esc(value: string): string {
  return value.replace(/[",\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function groupOf(match: Match): string {
  const category = match.category.replace(/[-_]+/g, " ").trim();
  return category ? category.charAt(0).toUpperCase() + category.slice(1) : "Live";
}

function entry(origin: string, match: Match, link: StreamLink): string {
  const quality = link.hd ? "HD" : "SD";
  const label = `${match.title} — Stream ${link.streamNo} (${quality})`;
  const attrs =
    ` tvg-id="${esc(`${link.source}:${link.id}`)}"` +
    ` tvg-name="${esc(match.title)}"` +
    ` group-title="${esc(groupOf(match))}"`;
  const target = `${origin}/api/hls?${new URLSearchParams({
    source: link.source,
    id: link.id,
  })}`;
  return `#EXTINF:-1${attrs},${label}\n${target}`;
}

async function buildPlaylist(origin: string, sport: string): Promise<{ body: string; count: number }> {
  const matches = await listLiveCatalog(sport === "all" ? null : sport);
  const blocks = await Promise.all(
    matches.map(async (match) => {
      const links = await listMatchStreams(match).catch(() => [] as StreamLink[]);
      return links.map((link) => entry(origin, match, link));
    }),
  );
  const lines = blocks.flat();
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const header = `#EXTM3U\n# DamiTV dynamic playlist — generated ${stamp} UTC — ${lines.length} entries`;
  return { body: lines.length ? `${header}\n${lines.join("\n")}\n` : `${header}\n`, count: lines.length };
}

export async function handlePlaylist(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sport = url.searchParams.get("sport") ?? "all";
  const download = url.searchParams.get("download") === "1";

  try {
    const hit = cache.get(sport);
    let body: string;
    let count: number;
    if (hit && Date.now() - hit.at < ttlMs) {
      ({ body, count } = hit);
    } else {
      const built = await buildPlaylist(url.origin, sport);
      ({ body, count } = built);
      cache.set(sport, { at: Date.now(), ...built });
    }

    const headers = new Headers({
      "Content-Type": "application/x-mpegurl",
      "Cache-Control": "no-store",
      "X-Playlist-Entries": String(count),
    });
    if (download) {
      const safe = sport.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
      headers.set(
        "Content-Disposition",
        `attachment; filename="damitv${safe && safe !== "all" ? `-${safe}` : ""}.m3u"`,
      );
    }
    return new Response(body, { status: 200, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
