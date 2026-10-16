import { Worker } from "node:worker_threads";

import { fetchTimeoutMs, userAgent } from "../config/site.js";
import type { EmbedSlot } from "./slot.js";

function varint(n: number): number[] {
  const bytes: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return bytes;
}

// /fetch takes a minimal protobuf body: field 1 = the embed path.
function encodeFetchBody(path: string): Buffer {
  const bytes = Buffer.from(path, "utf8");
  const len = varint(bytes.length);
  return Buffer.concat([Buffer.from([0x0a, ...len]), bytes]);
}

async function postEmbedFetch(embed: EmbedSlot): Promise<{ island: string; body: Buffer }> {
  const res = await fetch(`${embed.origin}/fetch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Origin: embed.origin,
      Referer: `${embed.origin}/embed/${embed.path}`,
      "User-Agent": userAgent,
    },
    body: encodeFetchBody(embed.path),
    signal: AbortSignal.timeout(fetchTimeoutMs),
  });
  if (!res.ok) throw new Error(`embed /fetch ${res.status}`);
  const island = res.headers.get("island");
  if (!island) throw new Error("missing island header");
  return { island, body: Buffer.from(await res.arrayBuffer()) };
}

export function unlockEmbed(embed: EmbedSlot): Promise<string> {
  return postEmbedFetch(embed).then(({ island, body }) => {
    return new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL("./decrypt-worker.js", import.meta.url), {
        workerData: { origin: embed.origin, path: embed.path, island, bodyHex: body.toString("hex") },
      });
      worker.once("message", (msg: { ok: boolean; url?: string; error?: string }) => {
        void worker.terminate();
        if (msg.ok && msg.url) resolve(msg.url);
        else reject(new Error(msg.error || "gasm decrypt failed"));
      });
      worker.once("error", (err) => {
        void worker.terminate();
        reject(err);
      });
    });
  });
}
