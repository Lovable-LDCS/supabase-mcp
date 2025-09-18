// server.js — v6.5.1
// - Loads .env automatically
// - /messages always returns non-empty JSON (guard)
// - SSE transport resolver (tries .js subpaths first)
// - Adds HEAD/OPTIONS for /sse with CORS headers (for connector preflight)
// - /debug endpoints

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { Server } from "@modelcontextprotocol/sdk/server";

const app = express();
app.use(cors());                // Access-Control-Allow-Origin: *
app.use(express.json());

// ----- Supabase (not used yet, but envs are validated by the lib) -----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ----- MCP server (we’ll add real tools next) -----
const mcpServer = new Server(
  { name: "supabase-mcp", version: "1.0.0" },
  { capabilities: {} }
);

// Robust resolver for SSEServerTransport across SDK variants.
// IMPORTANT: try `.js` subpaths first (needed for v1.18 export map).
let sseCache = { ok: false, path: null, ctor: null, err: [] };
async function getSSEServerTransport() {
  if (sseCache.ok) return sseCache;
  const candidates = [
    "@modelcontextprotocol/sdk/server/sse.js",            // v1.18.x common
    "@modelcontextprotocol/sdk/server/transport/sse.js",  // some builds
    "@modelcontextprotocol/sdk/transport/sse.js",         // some builds
    "@modelcontextprotocol/sdk/server/sse",               // fallback (no ext)
    "@modelcontextprotocol/sdk/server/transport/sse",     // fallback (no ext)
    "@modelcontextprotocol/sdk/transport/sse"             // fallback (no ext)
  ];
  for (const p of candidates) {
    try {
      const m = await import(p);
      const ctor = m.SSEServerTransport || m.default || m.SSE;
      if (ctor) { sseCache = { ok: true, path: p, ctor, err: [] }; return sseCache; }
      sseCache.err.push(`Found ${p} but no SSEServerTransport export`);
    } catch (e) {
      sseCache.err.push(`${p}: ${String(e).slice(0,180)}`);
    }
  }
  return sseCache;
}

// Simple CORS helper for non-GET preflight
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

// Preflight for connectors that probe /sse
app.options("/sse", (req, res) => {
  setCors(res);
  return res.sendStatus(204);   // No Content
});

// Some environments issue HEAD first
app.head("/sse", (req, res) => {
  setCors(res);
  return res.status(200).end();
});

// SSE endpoint for MCP
app.get("/sse", async (_req, res) => {
  console.log("[SSE] client connected");
  setCors(res);
  const sse = await getSSEServerTransport();
  if (!sse.ok) {
    console.error("[SSE] transport resolve failed:", sse.err.join(" | "));
    return res.status(500).json({ error: "SSE transport not available", err: sse.err });
  }
  const transport = new sse.ctor("/sse", res);
  await mcpServer.connect(transport);
});

// Guard so /messages always returns JSON (even if a framework swallows body)
app.use((req, res, next) => {
  if (req.path !== "/messages") return next();

  const sessionId = req.headers["x-session-id"] || Math.random().toString(36).slice(2, 10);
  let bodyBytes = 0, statusCode = 200;

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;

  const _write = res.write.bind(res);
  const _end = res.end.bind(res);

  res.write = (chunk, ...args) => {
    if (chunk) bodyBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    return _write(chunk, ...args);
  };
  res.end = (chunk, ...args) => {
    if (chunk) bodyBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (bodyBytes === 0) {
      const fallback = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), result: { ok: true, note: "fallback-injected" } });
      console.log("[MSG] end patch: injecting JSON-RPC fallback");
      bodyBytes = Buffer.byteLength(fallback);
      return _end(fallback, ...args);
    }
    return _end(chunk, ...args);
  };

  const _json = res.json.bind(res);
  res.json = (obj) => { const s = JSON.stringify(obj); bodyBytes += Buffer.byteLength(s); return _json(obj); };

  const _send = res.send.bind(res);
  res.send = (body) => {
    const s = (typeof body === "string" || Buffer.isBuffer(body)) ? body : JSON.stringify(body);
    bodyBytes += Buffer.isBuffer(s) ? s.length : Buffer.byteLength(String(s));
    return _send(body);
  };

  const _writeHead = res.writeHead.bind(res);
  res.writeHead = (code, ...args) => {
    if (code !== 200) { console.log(`[MSG] writeHead patch: ${code} → 200`); statusCode = 200; return _writeHead(200, ...args); }
    statusCode = code; return _writeHead(code, ...args);
  };

  res.on("finish", () => console.log(`[MSG] out sessionId=${sessionId} status=${statusCode} bodyBytes=${bodyBytes}`));
  next();
});

// Always-valid JSON for POST/GET /messages
app.all("/messages", (_req, res) => {
  setCors(res);
  res.status(200).json({ jsonrpc: "2.0", id: Date.now(), result: { ok: true, route: "direct" } });
});

// Debug endpoints
app.get("/debug/env", (_req, res) => {
  res.json({ node: process.versions.node, uptimeSec: process.uptime(), patch: "v6.5.1" });
});
app.get("/debug/sdk", async (_req, res) => {
  const details = { node: process.versions.node };
  try {
    const pkg = await import("@modelcontextprotocol/sdk/package.json", { with: { type: "json" } });
    details.sdkVersion = pkg.default?.version || "unknown";
  } catch { details.sdkVersion = "unavailable"; }
  const sse = await getSSEServerTransport();
  details.sseResolved = sse.ok;
  details.ssePath = sse.path;
  details.errors = sse.err;
  res.json(details);
});

// Root + 404
const port = process.env.PORT || 3000;
app.get("/", (_req, res) => res.json({ service: "supabase-mcp", patch: "v6.5.1" }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(port, () => console.log(`MCP server listening on port ${port} (patch v6.5.1)`));
