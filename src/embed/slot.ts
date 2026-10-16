import { damitvEmbedOrigin } from "../config/site.js";

export type EmbedSlot = {
  origin: string;
  path: string;
};

export function makeEmbedSlot(id: string, origin = damitvEmbedOrigin): EmbedSlot {
  return { origin, path: id };
}

// Stream links carry absolute embed URLs ("/embed/<id>" on the platform
// origin); the decrypt handshake needs the origin plus the bare path.
export function slotFromEmbedUrl(embedUrl: string, fallbackId: string): EmbedSlot {
  try {
    const url = new URL(embedUrl);
    const path = url.pathname.replace(/^\/embed\/?/, "").replace(/^\/+|\/+$/g, "");
    return { origin: url.origin, path: path || fallbackId };
  } catch {
    return { origin: damitvEmbedOrigin, path: fallbackId };
  }
}
