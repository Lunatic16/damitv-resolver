import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../client");

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
};

export function serveClient(pathname: string): Response {
  const file = pathname === "/" ? "/index.html" : pathname;
  const path = join(root, file);
  if (!path.startsWith(root)) return new Response("forbidden", { status: 403 });
  try {
    const body = readFileSync(path);
    const ext = path.slice(path.lastIndexOf("."));
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": types[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" },
    });
  } catch {
    if (pathname !== "/" && !pathname.includes(".")) {
      return serveClient("/");
    }
    return new Response("not found", { status: 404 });
  }
}
