import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { corsOrigin, port, publicOrigin } from "../config/site.js";
import { handleRequest } from "./router.js";

// The origin every generated link must use. PUBLIC_ORIGIN wins (deterministic
// behind a reverse proxy); otherwise X-Forwarded-Proto/-Host, then Host.
function requestOrigin(incoming: IncomingMessage): string {
  if (publicOrigin) return publicOrigin;
  const pick = (value: string | string[] | undefined): string | undefined =>
    (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() || undefined;
  const host = pick(incoming.headers["x-forwarded-host"]) ?? incoming.headers.host ?? `localhost:${port}`;
  const proto = pick(incoming.headers["x-forwarded-proto"]) ?? "http";
  return `${proto}://${host}`;
}

function applyCors(outgoing: import("node:http").ServerResponse): void {
  outgoing.setHeader("Access-Control-Allow-Origin", corsOrigin);
  outgoing.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  outgoing.setHeader("Access-Control-Allow-Headers", "*");
  outgoing.setHeader("Access-Control-Max-Age", "86400");
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

createServer((incoming, outgoing) => {
  void (async () => {
    if (incoming.method === "OPTIONS") {
      applyCors(outgoing);
      outgoing.statusCode = 204;
      outgoing.end();
      return;
    }
    const origin = requestOrigin(incoming);
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      }
    }
    const body = await readBody(incoming);
    const abort = new AbortController();
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) abort.abort();
    });
    const init: RequestInit = {
      method: incoming.method ?? "GET",
      headers,
      signal: abort.signal,
    };
    if (body && body.length) init.body = new Uint8Array(body);
    const request = new Request(`${origin}${incoming.url ?? "/"}`, init);
    const response = await handleRequest(request);
    if (outgoing.writableEnded || abort.signal.aborted) return;
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    if (!outgoing.getHeader("Access-Control-Allow-Origin")) applyCors(outgoing);
    if (!response.body) {
      outgoing.end();
      return;
    }
    const nodeBody = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    nodeBody.on("error", () => {
      if (!outgoing.writableEnded) outgoing.destroy();
    });
    outgoing.on("close", () => {
      nodeBody.destroy();
    });
    nodeBody.pipe(outgoing);
  })().catch((error: unknown) => {
    if (outgoing.writableEnded) return;
    outgoing.statusCode = 500;
    outgoing.end(error instanceof Error ? error.message : "internal error");
  });
}).listen(port, () => {
  console.log(`http://localhost:${port}`);
});
