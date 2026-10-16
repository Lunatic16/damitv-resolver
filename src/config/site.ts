export const port = Number(process.env.PORT ?? "3000");

export const fetchTimeoutMs = Number(process.env.FETCH_TIMEOUT_MS ?? "15000");

// DAMITV mirrors the streamed.pk API family: /papi/sports, /papi/matches/{all,live},
// /papi/stream/{source}/{id}. This is the up-to-date catalog source.
export const damitvApiBase = process.env.DAMITV_API_BASE ?? "https://damitv.st/papi";

// Origin of the embed player pages (the wasm handshake host). The public API
// only returns relative /embed/... paths; this is where they resolve.
export const damitvEmbedOrigin = process.env.DAMITV_EMBED_ORIGIN ?? "https://taifood-blog.asia";

export const userAgent =
  process.env.USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Public base URL for every link the server generates (relay URLs, playlist
// entries). Set it when running behind a reverse proxy; otherwise
// X-Forwarded-Proto / X-Forwarded-Host are honored, then the Host header.
export const publicOrigin = (process.env.PUBLIC_ORIGIN ?? "").replace(/\/$/, "");

// Access-Control-Allow-Origin for API responses ("*" by default).
export const corsOrigin = process.env.CORS_ORIGIN ?? "*";
