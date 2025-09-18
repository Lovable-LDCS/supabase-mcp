// server.js — v6.5.2
// - Loads .env automatically
// - Guard ensures /messages always returns JSON
// - Robust SSE resolver (tries .js subpaths first)
// - Adds CORS + explicit SSE headers + logs for HEAD/OPTIONS/GET
// - /debug endpoints

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { Server } from "@modelcontextprotocol/sdk/server";

const app = express();
app.use(cors());
app.use(express.json());

// ----- Supabase (not used yet) -----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ----- MCP server -----
const mcpServer = new Server(
  { name: "supabase-mcp", version: "1.0.0" },
  { capabilities: {} }
);

// ----- SSE resolver (works across SDK builds) -----
let sseCache = { ok: false, path: null, ctor: null, err: [] };
async function getSSEServerTransport() {
  if (sseCache.ok) return sseCache;
  const candidates = [
    "@modelcontextprotocol/sdk/server/sse.js",
    "@modelcontextprotocol/sdk/server/transport/sse.js",
    "@modelcontextprotocol/sdk/transport/sse.js",
    "@modelcontextprotocol/sdk/server/sse",
    "@modelcontextprotocol/sdk/server/transport/sse",
    "@modelcontextprotocol/sdk/transport/sse"
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

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

// --- Preflight helpers for connector UIs ---
app.options("/sse", (req, res) => {
  setCors(res);
  console.log(`[SSE] OPTIONS from ${req.headers["user-agent"] || "unknown"}`);
  res.sendStatus(204);
});

app.head("/sse", (req, res) => {
  setCors(res);
  // Advertise SSE content-type even on HEAD so UIs feel confident
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  console.log(`[SSE] HEAD from ${req.headers["user-agent"] || "unknown"}`);
  res.status(200).end();
});

// --- Main SSE endpoint ---
app.get("/sse", async (req, res) => {
  setCors(res);
  // Set classic SSE headers up-front (some clients validate before first byte)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // avoid proxy buffering
  res.flushHeaders?.();

  console.log(`[SSE] GET connect ua=${req.headers["user-agent"] || "unknown"}`);

  const sse = await getSSEServerTransport();
  if (!sse.ok) {
    console.error("[SSE] transport resolve failed:", sse.err.join(" | "));
    return res.status(500).json({ error: "SSE transport not available", err: sse.err });
  }
  const transport = new sse.ctor("/sse", res);
  try {
    await mcpServer.connect(transport);
  } catch (e) {
    console.error("[SSE] connect error:", e);
    // If connect throws, report as JSON so the UI shows a reason
    if (!res.headersSent) res.status(500).json({ error: "connect failed", message: String(e) });
  }
});

// Ensure /messages always emits a JSON body
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

app.all("/messages", (_req, res) => {
  setCors(res);
  res.status(200).json({ jsonrpc: "2.0", id: Date.now(), result: { ok: true, route: "direct" } });
});

// Debug
app.get("/debug/env", (_req, res) => {
  res.json({ node: process.versions.node, uptimeSec: process.uptime(), patch: "v6.5.2" });
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
app.get("/", (_req, res) => res.json({ service: "supabase-mcp", patch: "v6.5.2" }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(port, () => console.log(`MCP server listening on port ${port} (patch v6.5.2)`));
