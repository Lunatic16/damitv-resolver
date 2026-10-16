import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { Window } from "happy-dom";

const vendorDir = join(dirname(fileURLToPath(import.meta.url)), "wasm");
const wasmBytes = readFileSync(join(vendorDir, "gasm.wasm"));
const glueUrl = pathToFileURL(join(vendorDir, "gasm.js")).href;

type WasmMemory = { buffer: ArrayBuffer };

type WasmApi = {
  memory: WasmMemory;
  set_stream_jw: (island: string, body: Uint8Array) => Promise<void>;
};

type WorkerInput = { origin: string; path: string; island: string; bodyHex: string };

function asBody(data: Buffer): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// The /fetch response body is protobuf: field 1 is the encrypted payload,
// field 2 is the plaintext slug the wasm weaves into the secure URL.
function slugFromFetchBody(body: Buffer): string | null {
  let i = 0;
  while (i < body.length) {
    const tag = body[i++]!;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire !== 2) break;
    let len = 0;
    let shift = 0;
    while (i < body.length) {
      const byte = body[i++]!;
      len |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    if (i + len > body.length) break;
    const value = body.subarray(i, i + len).toString("utf8");
    i += len;
    if (field === 2 && value && !value.startsWith("{")) return value;
  }
  return null;
}

function extractUrl(memory: WasmMemory, slug: string | null): string | null {
  const text = Buffer.from(memory.buffer).toString("latin1");
  // URL shapes vary per source: ppv-family slots yield /secure/<token>/…/index.m3u8,
  // others yield direct CDN playlists (e.g. akamai /hls/live/<id>/<Name>/master.m3u8).
  // Harvest any m3u8 URL the decrypt left in linear memory; the match ends at
  // ".m3u8" so trailing linear-memory bytes are never part of the URL.
  const re = /https?:\/\/[A-Za-z0-9.-]+[^\x00-\x1f\s"'`\\<>]*?\.m3u8(?![A-Za-z0-9])/g;
  const matches = [...new Set([...text.matchAll(re)].map((match) => match[0]))];
  if (!matches.length) return null;
  if (slug) {
    const exact = matches.find((url) => url.includes(`/${slug}/`));
    if (exact) return exact;
    const loose = matches.find((url) => url.toLowerCase().includes(slug.toLowerCase()));
    if (loose) return loose;
  }
  return matches.at(-1) ?? null;
}

async function crack(input: WorkerInput): Promise<string> {
  const { origin, path, island } = input;
  const body = Buffer.from(input.bodyHex, "hex");
  const slug = slugFromFetchBody(body);

  const jwEngine = { destroy() {} };
  const jwPlayer = {
    remove() {},
    setup() {},
    on() {},
    load() {},
    getPlaylistItem: () => ({}),
    getState: () => "idle",
  };
  Object.defineProperty(jwPlayer, "__wasm_jw_player", { value: jwPlayer, enumerable: false });
  Object.defineProperty(jwEngine, "__wasm_jw_engine", { value: jwEngine, enumerable: false });

  const window = new Window({
    url: `${origin}/embed/${path}`,
    settings: { disableJavaScriptFileLoading: true },
  });
  window.eval = () => undefined;
  Object.assign(window, {
    jwplayer: () => jwPlayer,
    __wasm_jw_player: jwPlayer,
    __wasm_jw_engine: jwEngine,
    __wasm_player: { core: { mediaControl: { volume: 0 } } },
    __wasm_p2p_config: {},
    P2PEngineHls: class {},
  });

  // The wasm-bindgen glue resolves DOM constructors from the global scope and
  // guards with instanceof. Mirror every happy-dom global onto globalThis —
  // happy-dom binds per-window interfaces, so document must additionally be
  // bound to its real constructor or `document instanceof Document` is false
  // and the wasm bails out with an empty rejection before any fetch.
  const sandbox = globalThis as unknown as Record<string, unknown>;
  let proto: object | null = window;
  const names = new Set<string>();
  while (proto) {
    for (const key of Object.getOwnPropertyNames(proto)) names.add(key);
    proto = Object.getPrototypeOf(proto);
  }
  for (const key of names) {
    if (key in sandbox) continue;
    try {
      const value = (window as unknown as Record<string, unknown>)[key];
      if (typeof value === "function") sandbox[key] = value;
    } catch {
      // Lazy property that threw on access — the wasm does not need it.
    }
  }
  sandbox.Document = (window.document as unknown as { constructor: unknown }).constructor;

  // The wasm re-issues the /fetch request itself and expects the exact
  // handshake response (island key + body) back; relative URLs resolve
  // against the embed origin.
  const embedFetch = async () =>
    new window.Response(asBody(body), {
      status: 200,
      headers: { "content-type": "application/octet-stream", island },
    });

  const root = globalThis as Record<string, unknown>;
  const saved = {
    fetch: root.fetch,
    Request: root.Request,
    Response: root.Response,
    window: root.window,
    document: root.document,
    location: root.location,
    self: root.self,
    jwplayer: root.jwplayer,
  };

  const resolveEmbedUrl = (url: string) => (url.startsWith("/") ? `${origin}${url}` : url);
  const SandboxRequest = (window as unknown as { Request: typeof globalThis.Request }).Request;
  const PatchedRequest = class extends SandboxRequest {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(typeof input === "string" ? resolveEmbedUrl(input) : input, init);
    }
  };

  globalThis.fetch = embedFetch as unknown as typeof globalThis.fetch;
  window.fetch = embedFetch as unknown as typeof window.fetch;
  globalThis.Request = PatchedRequest as unknown as typeof globalThis.Request;
  globalThis.Response = window.Response as unknown as typeof globalThis.Response;
  sandbox.Headers = (window as unknown as Record<string, unknown>).Headers;
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    self: window,
    jwplayer: (window as unknown as Record<string, unknown>).jwplayer,
  });

  try {
    const mod = (await import(glueUrl)) as {
      default: (opts: { module_or_path: Buffer }) => Promise<WasmApi>;
    };
    const wasm = await mod.default({ module_or_path: wasmBytes });
    const result = wasm.set_stream_jw(island, asBody(body));
    await Promise.race([
      result,
      new Promise((_, reject) => setTimeout(() => reject(new Error("decrypt timeout")), 15_000)),
    ]).catch(() => {});

    const url = extractUrl(wasm.memory, slug);
    if (!url) throw new Error("decrypt did not yield m3u8 url");
    return url;
  } finally {
    Object.assign(globalThis, saved);
  }
}

const input = workerData as WorkerInput;
crack(input)
  .then((url) => parentPort?.postMessage({ ok: true, url }))
  .catch((err: unknown) =>
    parentPort?.postMessage({
      ok: false,
      error: err instanceof Error ? err.message || err.stack || "gasm decrypt failed" : String(err),
    }),
  );
