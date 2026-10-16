import { userAgent } from "../config/site.js";

export function httpHeaders(referer?: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": userAgent, ...extra };
  if (referer) headers.Referer = referer;
  return headers;
}
