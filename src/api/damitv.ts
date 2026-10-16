import { damitvApiBase, fetchTimeoutMs } from "../config/site.js";
import { sourceRank } from "../config/sources.js";
import type { Match, Source, Sport, StreamLink } from "../types/models.js";
import { httpHeaders } from "./headers.js";

const catalogTtlMs = 20_000;
const catalogCache = new Map<string, { at: number; value: unknown }>();

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
    headers: httpHeaders(undefined, { Accept: "application/json" }),
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
export function listStreams(source: string, id: string): Promise<StreamLink[]> {
  return getJson(`/stream/${encodeURIComponent(source)}/${encodeURIComponent(id)}`);
}

async function matchHasStreams(match: Match): Promise<boolean> {
  if (!match.sources.length) return false;
  return new Promise((resolve) => {
    let left = match.sources.length;
    let settled = false;
    for (const src of match.sources) {
      void listStreams(src.source, src.id)
        .then((links) => {
          if (settled) return;
          if (links.length > 0) {
            settled = true;
            resolve(true);
            return;
          }
          left -= 1;
          if (left === 0) resolve(false);
        })
        .catch(() => {
          if (settled) return;
          left -= 1;
          if (left === 0) resolve(false);
        });
    }
  });
}

async function withActiveStreams(matches: Match[]): Promise<Match[]> {
  const flags = await Promise.all(matches.map(matchHasStreams));
  return matches.filter((_, index) => flags[index]);
}

async function listLive(sport?: string | null): Promise<Match[]> {
  const live = await fetchMatches("/matches/live");
  return withActiveStreams(live.filter(sportFilter(sport)));
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
  return listLive(sport);
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
    .filter((link) => link.source && link.id && link.embedUrl)
    .sort(
      (a, b) =>
        sourceRank(a.source) - sourceRank(b.source) || Number(b.hd) - Number(a.hd) || a.streamNo - b.streamNo,
    );
}
