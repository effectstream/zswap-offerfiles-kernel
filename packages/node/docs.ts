// Serve the Vite-built API playground at GET /docs (and /docs/* assets).
// Dev: run `bun run docs:dev` (Vite on :10601). Prod/preview: `bun run docs:build`
// then this route serves docs/dist.

import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const DIST = resolve(import.meta.dirname!, "../../docs/dist");
const INDEX = join(DIST, "index.html");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function safeJoin(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  if (!full.startsWith(root + sep) && full !== root) return null;
  return full;
}

export function registerDocsRoutes(server: any): void {
  server.get(
    "/docs",
    { config: { rateLimit: false } },
    async (_request: any, reply: any) => {
      if (!existsSync(INDEX)) {
        return reply.code(503).type("text/html").send(
          `<!doctype html><meta charset=utf-8><title>Docs</title>
           <body style="font:14px system-ui;padding:2rem;background:#111;color:#eee">
           <h1>API playground not built</h1>
           <p>Run <code>bun run docs:dev</code> (http://localhost:10601/docs/) or
           <code>bun run docs:build</code> then restart the node.</p></body>`,
        );
      }
      return reply.type("text/html; charset=utf-8").send(createReadStream(INDEX));
    },
  );

  server.get(
    "/docs/",
    { config: { rateLimit: false } },
    async (_request: any, reply: any) => {
      if (!existsSync(INDEX)) {
        return reply.redirect("/docs");
      }
      return reply.type("text/html; charset=utf-8").send(createReadStream(INDEX));
    },
  );

  // SPA assets + client-side routes under /docs/*
  server.get(
    "/docs/*",
    { config: { rateLimit: false } },
    async (request: any, reply: any) => {
      const rest = String((request.params as any)["*"] ?? "");
      if (rest.includes("..")) return reply.code(400).send({ error: "bad path" });

      // Exact asset file?
      if (rest && existsSync(DIST)) {
        const file = safeJoin(DIST, rest);
        if (file && existsSync(file) && statSync(file).isFile()) {
          const type = MIME[extname(file)] ?? "application/octet-stream";
          return reply.type(type).send(createReadStream(file));
        }
        // Vite puts assets under assets/
        const underAssets = safeJoin(DIST, join("assets", rest));
        if (underAssets && existsSync(underAssets) && statSync(underAssets).isFile()) {
          const type = MIME[extname(underAssets)] ?? "application/octet-stream";
          return reply.type(type).send(createReadStream(underAssets));
        }
      }

      if (!existsSync(INDEX)) {
        return reply.code(503).send({ error: "docs not built — run bun run docs:build" });
      }
      // SPA fallback
      return reply.type("text/html; charset=utf-8").send(createReadStream(INDEX));
    },
  );
}
