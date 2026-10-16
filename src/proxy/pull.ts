import { Readable } from "node:stream";

import { Impit } from "impit";

import { httpHeaders } from "../api/headers.js";

// The CDNs behind the unlock filter by TLS fingerprint (JA3): plain runtime
// fetch gets 403 while a browser-impersonating client passes. Route every CDN
// pull through Impit's chrome transport, like the reference resolver does.
const cdn = new Impit({ browser: "chrome151" });

function requestHeaders(referer?: string, range?: string | null): Record<string, string> {
  const headers = httpHeaders(referer, { Accept: "*/*" });
  if (referer) headers.Origin = new URL(referer).origin;
  if (range) headers.Range = range;
  return headers;
}

export async function pullResponse(
  url: string,
  referer?: string,
  range?: string | null,
  signal?: AbortSignal,
): Promise<Response> {
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
