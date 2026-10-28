import { Readable } from "node:stream";
import { gunzipSync, inflateSync } from "node:zlib";

import { Impit } from "impit";

import { httpHeaders } from "../api/headers.js";

// Transport selection (verified 2026-10-27):
// - messi.damitv.st live-hls playlists are token-bound to the client that
//   minted the token via /papi/extract-url — that mint goes over plain
//   runtime fetch, and only the same plain stack passes the playlist gate
//   (browser-impersonating TLS stacks get nginx 403). Referer required.
// - The playlists' segments are TikTok CDN "image" URLs smuggling TS: their
//   CDN 403s any DamitTV Referer/Origin, so those ship with neither.
// - The legacy embed CDN (wasm handshake host) still JA3-filters plain
//   fetch, so it keeps the browser-impersonating client.
const cdn = new Impit({ browser: "chrome151" });

function isDamiHost(hostname: string): boolean {
  return hostname === "damitv.st" || hostname.endsWith(".damitv.st") || hostname === "ondemand.st";
}

function isTikTokHost(hostname: string): boolean {
  return hostname.includes("tiktokcdn") || hostname.endsWith("tiktok.com") || hostname.endsWith("tiktokcdn.com");
}

function requestHeaders(referer?: string, range?: string | null, stripReferer = false): Record<string, string> {
  const effective = stripReferer ? undefined : referer;
  const headers = httpHeaders(effective, { Accept: "*/*" });
  if (effective) headers.Origin = new URL(effective).origin;
  if (range) headers.Range = range;
  return headers;
}

export async function pullResponse(
  url: string,
  referer?: string,
  range?: string | null,
  signal?: AbortSignal,
): Promise<Response> {
  const hostname = new URL(url).hostname;
  if (isTikTokHost(hostname) || isDamiHost(hostname)) {
    const init: RequestInit = {
      headers: requestHeaders(referer, range, isTikTokHost(hostname)),
      redirect: "follow",
    };
    if (signal) init.signal = signal;
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`upstream ${res.status}: ${res.statusText.trim() || "failed"}`);
    return res as unknown as Response;
  }
  const init: Parameters<typeof cdn.fetch>[1] = { headers: requestHeaders(referer, range) };
  if (signal) init.signal = signal;
  const res = await cdn.fetch(url, init);
  if (!res.ok) throw new Error(`upstream ${res.status}: ${res.statusText.trim() || "failed"}`);
  return res as unknown as Response;
}

export async function pull(url: string, referer?: string): Promise<Buffer> {
  return Buffer.from(await (await pullResponse(url, referer)).arrayBuffer());
}

// --- WEBP-wrapped MPEG-TS -------------------------------------------------
// Segments ship disguised as images: a RIFF/WEBP header wraps the TS payload
// (either after an EXIF chunk or directly at the declared RIFF end). Detect
// per response, floor to whole 188-byte packets, stream out early, and abort
// the upstream pull the moment the TS body is complete.

type TsMeta = { offset: number; length: number };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- PNG pixel smuggling (TIKTIKPX, dl/ relays) ----------------------------
// A real 8-bit RGB(A) PNG whose raw pixel bytes spell "TIKTIKPX" + u32 BE
// length + gzip(TS). Needs the full body: the whole IDAT stream deflates to
// the filtered pixels, which are PNG-unfiltered to recover the payload.
function decodePngTs(buf: Buffer): Buffer | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
      bitDepth = buf[pos + 16] ?? 0;
      colorType = buf[pos + 17] ?? 0;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(buf.subarray(pos + 8, pos + 8 + length)));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return null;
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  let filtered: Buffer;
  try {
    filtered = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const out = Buffer.allocUnsafe(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    if (src + 1 + stride > filtered.length) return null;
    const filter = filtered[src++] ?? 0;
    const rowStart = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = filtered[src + i] ?? 0;
      const a = i >= bpp ? (out[rowStart + i - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[rowStart - stride + i] ?? 0) : 0;
      const c = y > 0 && i >= bpp ? (out[rowStart - stride + i - bpp] ?? 0) : 0;
      let v = x;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[rowStart + i] = v & 0xff;
    }
    src += stride;
  }
  if (out.length < 12 || out.toString("ascii", 0, 8) !== "TIKTIKPX") return null;
  const tsLen = out.readUInt32BE(8);
  if (tsLen <= 0 || 12 + tsLen > out.length) return null;
  try {
    return gunzipSync(out.subarray(12, 12 + tsLen));
  } catch {
    return null;
  }
}

function readWebpTsMeta(buf: Buffer, total: number): TsMeta | null {
  if (buf.length < 20 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const declaredEnd = 8 + buf.readUInt32LE(4);
  if (total > declaredEnd && buf.length > declaredEnd && buf[declaredEnd] === 0x47) {
    const length = Math.floor((total - declaredEnd) / 188) * 188;
    return length > 0 ? { offset: declaredEnd, length } : null;
  }
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const tag = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (tag === "EXIF" || tag === "exif") {
      const length = Math.floor(size / 188) * 188;
      return length > 0 ? { offset: data, length } : null;
    }
    const next = data + size + (size & 1);
    if (next > buf.length) return null;
    offset = next;
  }
  return null;
}

export type SegmentStream = {
  stream: Readable;
  contentLength: number | null;
  unwrapped: boolean;
  contentType: string | null;
};

// Streams a segment. WEBP-wrapped bodies are unwrapped to raw TS; anything
// else (raw TS, keys, arbitrary binaries) streams through verbatim.
export function pullSegmentStream(
  url: string,
  referer?: string,
  signal?: AbortSignal,
): Promise<SegmentStream> {
  const ac = new AbortController();
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  signal?.addEventListener("abort", () => ac.abort(), { once: true });

  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    let settled = false;
    let finished = false;
    let unwrapped = false;
    let pngMode = false;
    let left = 0;
    let total = 0;
    let upstreamType: string | null = null;
    let out: Readable | null = null;

    const stop = () => {
      if (!ac.signal.aborted) ac.abort();
    };

    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      stop();
      if (settled) {
        out?.destroy(error);
        return;
      }
      settled = true;
      reject(error);
    };

    const settle = (unwrap: boolean, meta: TsMeta | null) => {
      settled = true;
      unwrapped = unwrap;
      out = new Readable({
        read() {},
        destroy(_err, cb) {
          stop();
          cb(null);
        },
      });
      if (unwrap && meta) {
        const available = pending.subarray(meta.offset);
        const first = available.subarray(0, Math.min(available.length, meta.length));
        left = meta.length - first.length;
        out.push(first);
        if (left <= 0) {
          finished = true;
          stop();
          out.push(null);
        }
      } else {
        out.push(pending);
      }
      resolve({
        stream: out,
        contentLength: unwrap && meta ? meta.length : total || null,
        unwrapped,
        contentType: upstreamType,
      });
    };

    const onData = (raw: Buffer) => {
      if (finished) return;
      if (!settled) {
        pending = Buffer.concat([pending, raw]);
        if (!pngMode && pending.length >= 8 && pending.subarray(0, 8).equals(PNG_SIGNATURE)) {
          // TIKTIKPX pixel smuggling — hold the whole body, decode at end.
          pngMode = true;
          return;
        }
        if (pngMode) return;
        const meta = readWebpTsMeta(pending, total);
        if (meta) {
          settle(true, meta);
          return;
        }
        // Not a WEBP wrapper once we can tell — pass the body through as-is.
        if (pending.length >= 20 && pending.toString("ascii", 0, 4) !== "RIFF") {
          settle(false, null);
          return;
        }
        if (pending.length > 16384) fail(new Error("segment header not found"));
        return;
      }
      if (!out) return;
      if (unwrapped) {
        const take = raw.subarray(0, left);
        left -= take.length;
        out.push(take);
        if (left <= 0) {
          finished = true;
          stop();
          out.push(null);
        }
      } else {
        out.push(raw);
      }
    };

    void (async () => {
      const res = await pullResponse(url, referer, null, ac.signal);
      if (!res.body) throw new Error("empty upstream body");
      upstreamType = res.headers.get("content-type");
      const headerLen = Number(res.headers.get("content-length"));
      total = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : 0;
      const node = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
      node.on("data", (chunk: Buffer | Uint8Array) => onData(Buffer.from(chunk)));
      node.on("error", (err: Error) => {
        if (!finished) fail(err);
      });
      node.on("end", () => {
        if (finished) return;
        if (pngMode) {
          const ts = decodePngTs(pending);
          if (!ts) {
            fail(new Error("png segment decode failed"));
            return;
          }
          finished = true;
          settled = true;
          unwrapped = true;
          out = new Readable({ read() {} });
          out.push(ts);
          out.push(null);
          stop();
          resolve({
            stream: out,
            contentLength: ts.length,
            unwrapped: true,
            contentType: "video/mp2t",
          });
          return;
        }
        if (settled && !unwrapped) {
          finished = true;
          out?.push(null);
          return;
        }
        if (!settled) fail(new Error("cdn stream ended early"));
      });
    })().catch((err: unknown) => {
      if (!finished) fail(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
