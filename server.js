// server.js — v6.5.3
// - Fix: let SDK write SSE headers on GET /sse (no duplicate headers)
// - Keeps robust SSE resolver, /messages JSON-RPC handler, and debug endpoints

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { Server } from "@modelcontextprotocol/sdk/server";

const app = express();
app.use(cors());
app.use(express.json());

// ----- Supabase env sanity (will throw if missing) -----
createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ----- MCP server (we’ll add tools next) -----
const mcpServer = new Server(
  { name: "supabase-mcp", version: "1.0.0" },
  { capabilities: {} }
);

// ===== Robust SSE transport resolver (covers SDK v1.18.x shapes) =====
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

// ===== /sse lane =====

// Preflights/probes (fine to send headers here)
app.options("/sse", (req, res) => { setCors(res); res.sendStatus(204); });
app.head("/sse",    (req, res) => { setCors(res); res.status(200).end(); });

// IMPORTANT: for GET /sse do NOT send headers yourself.
// The SDK’s SSE transport will do that.
app.get("/sse", async (req, res) => {
  setCors(res);
  console.log("[SSE] client connected");
  const sse = await getSSEServerTransport();
  if (!sse.ok) {
    console.error("[SSE] transport resolve failed:", sse.err.join(" | "));
    return res.status(500).json({ error: "SSE transport not available", err: sse.err });
  }
  const transport = new sse.ctor("/sse", res);
  await mcpServer.connect(transport);
});

// ===== /messages lane (JSON-RPC handoff to SDK) =====
app.post("/messages", async (req, res) => {
  try {
    setCors(res);
    const body = req.body ?? {};
    if (typeof mcpServer.handleHTTP === "function") {
      const sessionId = req.get("x-session-id") || req.query.sessionId || undefined;
      const out = await mcpServer.handleHTTP(body, { sessionId });
      return res.status(200).json(out ?? {});
    }
    if (typeof mcpServer.handleRequest === "function") {
      const out = await mcpServer.handleRequest(body);
      return res.status(200).json(out ?? {});
    }
    return res.status(501).json({ error: "MCP HTTP handler not available in this SDK build" });
  } catch (e) {
    console.error("[/messages] error:", e);
    return res.status(200).json({
      jsonrpc: "2.0",
      id: (req.body && req.body.id) || null,
      error: { code: -32000, message: String(e).slice(0, 300) }
    });
  }
});

// Optional GET for quick smoke tests
app.get("/messages", (_req, res) =>
  res.status(200).json({ jsonrpc: "2.0", id: Date.now(), result: { ok: true, route: "direct" } })
);

// ===== Debug =====
app.get("/debug/env", (_req, res) =>
  res.json({ node: process.versions.node, uptimeSec: process.uptime(), patch: "v6.5.3" })
);

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
app.get("/", (_req, res) => res.json({ service: "supabase-mcp", patch: "v6.5.3" }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(port, () => console.log(`MCP server listening on port ${port} (patch v6.5.3)`));
