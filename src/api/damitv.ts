import { damitvApiBase, damitvReferer, fetchTimeoutMs } from "../config/site.js";
import { sourceRank } from "../config/sources.js";
import type { Match, Source, Sport, StreamLink } from "../types/models.js";
import { httpHeaders } from "./headers.js";

const catalogTtlMs = 20_000;
const catalogCache = new Map<string, { at: number; value: unknown }>();

// /papi/extract-url mints a fresh (12h) playlist token per call. Cache the
// payload briefly so catalog probing, stream chips and resolves within a
// minute share one mint instead of hammering the endpoint.
const extractTtlMs = 60_000;
const extractCache = new Map<string, { at: number; value: ExtractPayload | null }>();

type ExtractSubstream = {
  id?: string;
  name?: string;
  locale?: string;
  iframe?: string;
  embedUrl?: string;
};

type ExtractPayload = {
  success?: boolean;
  hlsUrl?: string;
  embedUrl?: string;
  substreams?: ExtractSubstream[];
};

type UpstreamMatch = {
  id: string;
  league: string;
  title: string;
  category: string;
  date: number;
  always_live: boolean;
  popular: boolean;
  poster: string;
  teams: Match["teams"];
  sources: Source[];
  status: string;
  viewers: number;
  embedUrl: string;
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${damitvApiBase}${path}`, {
    headers: httpHeaders(damitvReferer, { Accept: "application/json" }),
    signal: AbortSignal.timeout(fetchTimeoutMs),
  });
  if (!res.ok) throw new Error(`damitv ${path} ${res.status}`);
  return res.json() as Promise<T>;
}

async function getCatalogJson<T>(path: string): Promise<T> {
  const hit = catalogCache.get(path);
  if (hit && Date.now() - hit.at < catalogTtlMs) return hit.value as T;
  const value = await getJson<T>(path);
  catalogCache.set(path, { at: Date.now(), value });
  return value;
}

function normalizeMatch(raw: UpstreamMatch): Match {
  return {
    id: raw.id,
    title: raw.title,
    category: raw.category,
    league: raw.league,
    date: raw.date,
    status: raw.status,
    alwaysLive: Boolean(raw.always_live),
    popular: Boolean(raw.popular),
    poster: raw.poster,
    teams: raw.teams,
    viewers: raw.viewers,
    embedUrl: raw.embedUrl,
    sources: raw.sources ?? [],
  };
}

function isChannel(match: Match): boolean {
  return match.alwaysLive;
}

function sportFilter(sport?: string | null): (match: Match) => boolean {
  if (!sport || sport === "all") return () => true;
  return (match) => match.category === sport;
}

async function fetchMatches(path: string): Promise<Match[]> {
  const raw = await getCatalogJson<UpstreamMatch[]>(path);
  if (!Array.isArray(raw)) throw new Error("Unexpected API response shape");
  return raw.map(normalizeMatch);
}

export async function ping(): Promise<string> {
  const sports = await getJson<string[]>("/sports");
  if (!Array.isArray(sports)) throw new Error("Unexpected API response shape");
  return "ok";
}

export async function listSports(): Promise<Sport[]> {
  const ids = await getJson<string[]>("/sports");
  if (!Array.isArray(ids)) throw new Error("Unexpected API response shape");
  return ids.map((id) => ({
    id,
    name: id.replace(/[-_]+/g, " ").replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1)),
  }));
}

// Stream links are looked up live (never cached): tokens/links rotate and the
// upstream returns an empty array once a feed goes dark.
//
// The legacy per-source listing (/papi/stream/{source}/{id}) now answers [] for
// every match. The upstream moved stream discovery into /papi/extract-url,
// which returns a direct tokened playlist (hlsUrl) plus the provider embed.
// When the legacy listing comes back empty we derive links from extract-url.
export async function listStreams(source: string, id: string): Promise<StreamLink[]> {
  try {
    const upstream = await getJson<StreamLink[]>(
      `/stream/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
    );
    if (Array.isArray(upstream) && upstream.length) return upstream;
  } catch {
    // Legacy listing failed or changed shape — fall through to extract-url.
  }
  // extract-url covers regular matches and their substreams; manual (mm-*)
  // channels resolve through the per-match msrc list instead.
  const extracted = await extractLinks(id, source);
  if (extracted.length) return extracted;
  return msrcLinks(source, id);
}

// extract-url tokens are fingerprint-bound to the client that minted them
// (plain runtime fetch passes; browser-impersonating TLS stacks 403), so mint
// and fetch both happen here over plain fetch.
async function fetchExtract(channelId: string): Promise<ExtractPayload | null> {
  const hit = extractCache.get(channelId);
  if (hit && Date.now() - hit.at < extractTtlMs) return hit.value;
  let value: ExtractPayload | null = null;
  try {
    value = await getJson<ExtractPayload>(`/extract-url/${channelId}`);
    if (!value || typeof value !== "object") value = null;
  } catch {
    value = null;
  }
  extractCache.set(channelId, { at: Date.now(), value });
  return value;
}

// extract-url embedUrl values ship as "enc:<base64>" — the base64 payload is
// the embed URL with its characters reversed.
function decodeEmbedUrl(value: string | undefined): string {
  if (!value || !value.startsWith("enc:")) return value ?? "";
  try {
    const b64 = value.slice(4);
    return Buffer.from(b64, "base64").toString("utf8").split("").reverse().join("");
  } catch {
    return "";
  }
}

async function extractLinks(channelId: string, source: string): Promise<StreamLink[]> {
  const extract = await fetchExtract(channelId);
  if (!extract) return [];
  const links: StreamLink[] = [];
  if (extract.hlsUrl) {
    links.push({
      id: channelId,
      streamNo: 1,
      language: "",
      hd: true,
      embedUrl: decodeEmbedUrl(extract.embedUrl),
      m3u8: extract.hlsUrl,
      source,
      viewers: 0,
    });
  }
  let no = 1;
  for (const sub of extract.substreams ?? []) {
    const embed = sub.iframe ?? sub.embedUrl;
    if (!embed || !sub.id) continue;
    no += 1;
    const link: StreamLink = {
      id: sub.id,
      streamNo: no,
      language: sub.locale ?? "",
      hd: true,
      embedUrl: embed,
      source,
      viewers: 0,
    };
    if (sub.name) link.name = sub.name;
    links.push(link);
  }
  return links;
}

// --- Manual sources (mm-* channels) ---------------------------------------
// Operator-curated channel lists: /papi/msrc-for?id=<matchId> returns player
// entries whose url param carries the /dl/<n>.m3u8 relay path. Those relays
// need a short-lived hls-token minted at tune-in time. (extract-url answers
// "no sources" for these ids.)

type MsrcEntry = { url?: string; label?: string; name?: string };

const msrcTtlMs = 60_000;
const msrcCache = new Map<string, { at: number; value: MsrcEntry[] }>();

async function fetchMsrc(matchId: string): Promise<MsrcEntry[]> {
  const hit = msrcCache.get(matchId);
  if (hit && Date.now() - hit.at < msrcTtlMs) return hit.value;
  let value: MsrcEntry[] = [];
  try {
    const data = await getJson<MsrcEntry[]>(`/msrc-for?id=${encodeURIComponent(matchId)}`);
    if (Array.isArray(data)) value = data;
  } catch {
    value = [];
  }
  msrcCache.set(matchId, { at: Date.now(), value });
  return value;
}

// Manual source ids are the match id prefixed with "m-" (e.g. source id
// "m-mm-el-E2026-73" for match "mm-el-E2026-73"); msrc-for wants it bare.
function manualMatchId(id: string): string {
  return id.startsWith("m-") ? id.slice(2) : id;
}

// "/player/jw/?v=540&url=%2Fdl%2F26.m3u8&name=Magenta%20Sport%20309" → dlPath + label
function dlRelayOf(entry: MsrcEntry): { dlPath: string; name: string } | null {
  if (!entry.url) return null;
  const query = entry.url.split("?")[1] ?? "";
  const params = new URLSearchParams(query);
  const target = params.get("url") ?? "";
  if (!/^\/dl\/[^/]+\.m3u8$/.test(target)) return null;
  return { dlPath: target, name: entry.label || params.get("name") || "" };
}

async function msrcLinks(source: string, id: string): Promise<StreamLink[]> {
  const entries = await fetchMsrc(manualMatchId(id));
  const links: StreamLink[] = [];
  let no = 0;
  for (const entry of entries) {
    const relay = dlRelayOf(entry);
    if (!relay) continue;
    no += 1;
    const link: StreamLink = {
      id: manualMatchId(id),
      streamNo: no,
      language: "",
      hd: false,
      embedUrl: "",
      dlPath: relay.dlPath,
      source,
      viewers: 0,
    };
    if (relay.name) link.name = relay.name;
    links.push(link);
  }
  return links;
}

// hls-tokens live ~90 seconds — mint fresh at tune-in, never cache.
async function mintDlPlaylist(dlPath: string): Promise<{ m3u8: string; referer: string }> {
  const token = await getJson<{ tk?: string; e?: string | number }>("/hls-token");
  if (!token?.tk || token.e == null) throw new Error("hls-token mint failed");
  const base = new URL(damitvApiBase).origin;
  return { m3u8: `${base}${dlPath}?tk=${encodeURIComponent(token.tk)}&e=${encodeURIComponent(String(token.e))}`, referer: damitvReferer };
}

// Resolve a channel id (match id, manual source id, or substream id) to a
// relayable playlist: extract-url first, then the manual /dl relays, with an
// optional 1-based streamNo to pick among substreams / manual entries.
export async function resolveChannelM3u8(
  channelId: string,
  streamNo?: number,
): Promise<{ m3u8: string; referer: string } | null> {
  const extract = await fetchExtract(channelId);
  if (extract?.hlsUrl && (!streamNo || streamNo === 1)) {
    return { m3u8: extract.hlsUrl, referer: damitvReferer };
  }
  if (extract && streamNo && streamNo > 1) {
    const sub = extract.substreams?.[streamNo - 2];
    if (sub?.id) {
      const subExtract = await fetchExtract(sub.id);
      if (subExtract?.hlsUrl) return { m3u8: subExtract.hlsUrl, referer: damitvReferer };
    }
    return null;
  }
  const entries = await fetchMsrc(manualMatchId(channelId));
  const entry = entries[streamNo && streamNo > 1 ? streamNo - 1 : 0];
  const relay = entry ? dlRelayOf(entry) : null;
  if (relay) return mintDlPlaylist(relay.dlPath);
  return null;
}

export async function listMatches(sport: string | null, scope: "live" | "all" | "popular" = "live"): Promise<Match[]> {
  if (scope === "popular") {
    const popular = await fetchMatches("/matches/live/popular");
    return popular.filter(sportFilter(sport));
  }
  if (scope === "all") {
    const all = await fetchMatches("/matches/all");
    return all.filter(sportFilter(sport));
  }
  // /matches/live is curated upstream — entries are on-air right now and each
  // carries its stream sources, so the rail lists it as-is (the old
  // per-match stream probing filtered everything out and is gone).
  const live = await fetchMatches("/matches/live");
  return live.filter(sportFilter(sport));
}

export async function findMatch(matchId: string): Promise<Match> {
  const [live, all] = await Promise.all([
    fetchMatches("/matches/live"),
    fetchMatches("/matches/all"),
  ]);
  const match = live.find((item) => item.id === matchId) ?? all.find((item) => item.id === matchId);
  if (!match) throw new Error(`match not found: ${matchId}`);
  return match;
}

// Live matches plus 24/7 channels, without the active-stream probing —
// used by the IPTV playlist builder, which resolves lazily at tune-in.
export async function listLiveCatalog(sport?: string | null): Promise<Match[]> {
  const live = await fetchMatches("/matches/live");
  return live.filter(sportFilter(sport));
}

export async function listMatchStreams(match: Match): Promise<StreamLink[]> {
  const groups = await Promise.all(match.sources.map((src) => listStreams(src.source, src.id)));
  return groups
    .flat()
    .filter((link) => link.source && link.id && (link.embedUrl || link.m3u8 || link.dlPath))
    .sort(
      (a, b) =>
        sourceRank(a.source) - sourceRank(b.source) || Number(b.hd) - Number(a.hd) || a.streamNo - b.streamNo,
    );
}
