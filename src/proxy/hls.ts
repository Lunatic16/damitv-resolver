import { Readable } from "node:stream";

import { makeEmbedSlot } from "../embed/slot.js";
import { unlockEmbedSlot } from "../embed/unlock.js";
import { pullResponse, pullSegmentStream } from "./pull.js";
import { relayLink } from "./media.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
} as const;

const PLAYLIST_MIME = "application/vnd.apple.mpegurl";

const passThrough = ["content-type", "content-length", "content-range", "accept-ranges"] as const;

function isPlaylistResponse(upstream: Response, url: URL): boolean {
  if (/mpegurl/i.test(upstream.headers.get("content-type") ?? "")) return true;
  return /\.m3u8?($|\?)/i.test(url.pathname + url.search);
}

function rewrite(
  text: string,
  base: string,
  referer: string | undefined,
  origin: string,
  slot: { source: string; id: string } | undefined,
): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      // Non-tag lines are variant playlist or segment URIs
      if (!trimmed.startsWith("#")) return relayLink(origin, new URL(trimmed, base).href, referer, slot);
      // Rewrite URI="..." / URI='...' attributes inside tags
      // (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, ...)
      return trimmed.replace(/URI=("([^"]*)"|'([^']*)')/g, (_m, _q, dq: string, sq: string) =>
        `URI="${relayLink(origin, new URL(dq ?? sq, base).href, referer, slot)}"`,
      );
    })
    .join("\n");
}

export async function proxyHls(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const refererParam = url.searchParams.get("referer");
  const source = url.searchParams.get("source");
  const id = url.searchParams.get("id");
  let target = url.searchParams.get("url");
  let referer = refererParam ?? undefined;
  // Slot hint carried in url-mode relays: on an upstream rejection (tokens
  // live on one node of a rotating load balancer), re-mint and retry once.
  const slot = source && id ? { source, id } : undefined;

  try {
    // Slot mode: playlist entries point here so tokens are minted fresh at
    // tune-in time. The first playlist fetch resolves the slot; every URI it
    // returns is rewritten to url-mode, so refreshes stay cheap.
    if (!target && slot) {
      const unlocked = await unlockEmbedSlot(makeEmbedSlot(slot.id));
      target = unlocked.m3u8;
      referer = referer ?? unlocked.referer;
    }

    if (!target) return new Response("url (or source and id) required", { status: 400, headers: cors });
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return new Response("Invalid upstream URL", { status: 400, headers: cors });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return new Response("Only http(s) URLs are supported", { status: 400, headers: cors });
    }

    let upstream: Response;
    try {
      upstream = await pullResponse(target, referer, request.headers.get("range"), request.signal);
    } catch (err) {
      if (!slot) throw err;
      const healed = await unlockEmbedSlot(makeEmbedSlot(slot.id));
      target = healed.m3u8;
      referer = healed.referer;
      upstream = await pullResponse(target, referer, request.headers.get("range"), request.signal);
    }
    // If the origin redirected, rewrite relative URLs against the final URL
    const base = upstream.url && upstream.url !== target ? upstream.url : target;

    if (isPlaylistResponse(upstream, new URL(base))) {
      const body = Buffer.from(await upstream.arrayBuffer()).toString("utf8");
      if (!body.trim()) throw new Error("empty upstream body");
      return new Response(rewrite(body, base, referer, url.origin, slot), {
        status: 200,
        headers: { ...cors, "Content-Type": PLAYLIST_MIME },
      });
    }

    // Binary: segments ship WEBP-wrapped on this CDN — unwrap to raw TS;
    // anything else streams through verbatim.
    if (upstream.body) {
      const { stream, contentLength, unwrapped, contentType } = await pullSegmentStream(
        target,
        referer,
        request.signal,
      );
      const headers: Record<string, string> = { ...cors };
      if (unwrapped) {
        headers["Content-Type"] = "video/mp2t";
        if (contentLength) headers["Content-Length"] = String(contentLength);
      } else {
        headers["Content-Type"] = contentType ?? "application/octet-stream";
        if (contentLength) headers["Content-Length"] = String(contentLength);
      }
      return new Response(Readable.toWeb(stream) as import("node:stream/web").ReadableStream, {
        status: 200,
        headers,
      });
    }

    const headers: Record<string, string> = { ...cors };
    for (const header of passThrough) {
      const value = upstream.headers.get(header);
      if (value) headers[header] = value;
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), { status: 502, headers: cors });
  }
}
