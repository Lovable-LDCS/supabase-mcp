// server.js — v6.5.7
// - Add: OPTIONS /messages (CORS preflight → 204)
// - Add: log each POST /messages call (method + session id)
// - Keep: SSE transport with (req,res), minimal JSON-RPC fallback
// - Note: do NOT set headers for GET /sse; SDK owns them

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { Server } from "@modelcontextprotocol/sdk/server";

const app = express();
app.use(cors());
app.use(express.json());

// Supabase env sanity
createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// MCP server (tools will be added next)
const mcpServer = new Server(
  { name: "supabase-mcp", version: "1.0.0" },
  { capabilities: {} }
);

// Resolve SSE transport across SDK layouts
let sseCache = { ok: false, path: null, ctor: null, err: [] };
async function getSSEServerTransport() {
  if (sseCache.ok) return sseCache;
  const candidates = [
    "@modelcontextprotocol/sdk/server/sse.js",
    "@modelcontextprotocol/sdk/server/transport/sse.js",
    "@modelcontextprotocol/sdk/transport/sse.js",
    "@modelcontextprotocol/sdk/server/sse",
    "@modelcontextprotocol/sdk/server/transport/sse",
    "@modelcontextprotocol/sdk/transport/sse",
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

// Preflight/probe for /sse
app.options("/sse", (_req, res) => { setCors(res); res.sendStatus(204); });
app.head("/sse",    (_req, res) => { setCors(res); res.status(200).end(); });

// GET /sse → let the SDK set headers
app.get("/sse", async (req, res) => {
  setCors(res);
  console.log("[SSE] incoming GET", { ua: req.get("user-agent") });
  const sse = await getSSEServerTransport();
  if (!sse.ok) {
    console.error("[SSE] transport resolve failed:", sse.err.join(" | "));
    return res.status(500).json({ error: "SSE transport not available", err: sse.err });
  }
  try {
    const transport = new sse.ctor(req, res);   // yields /sse?sessionId=... in the hint
    await mcpServer.connect(transport);
    console.log("[SSE] connected via", sse.path);
  } catch (e) {
    console.error("[SSE] connect error:", e);
    if (!res.headersSent) return res.status(500).json({ error: String(e).slice(0,300) });
    try { res.end(); } catch {}
  }
});

// ---------- /messages ----------
app.options("/messages", (_req, res) => { setCors(res); res.sendStatus(204); }); // NEW

// Minimal JSON-RPC fallback for /messages
app.post("/messages", async (req, res) => {
  try {
    setCors(res);

    // NEW: visibility for UI attempts
    const method = req.body?.method || "<no-method>";
    const sid = req.get("x-session-id") || req.query.sessionId || "<none>";
    console.log("[/messages]", method, "sid=", sid);

    const body = req.body ?? {};
    const id = body.id ?? null;

    // Prefer SDK helpers if present
    if (typeof mcpServer.handleHTTP === "function") {
      const sessionId = sid !== "<none>" ? sid : undefined;
      const out = await mcpServer.handleHTTP(body, { sessionId });
      return res.status(200).json(out ?? {});
    }
    if (typeof mcpServer.handleRequest === "function") {
      const out = await mcpServer.handleRequest(body);
      return res.status(200).json(out ?? {});
    }

    // Fallbacks to satisfy connector creation
    if (method === "initialize") {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: { serverInfo: { name: "supabase-mcp", version: "1.0.0" }, capabilities: {} }
      });
    }
    if (method === "tools/list") {
      return res.status(200).json({ jsonrpc: "2.0", id, result: { tools: [] } });
    }

    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method ${method} not found` }
    });
  } catch (e) {
    console.error("[/messages] error:", e);
    return res.status(200).json({
      jsonrpc: "2.0",
      id: (req.body && req.body.id) || null,
      error: { code: -32000, message: String(e).slice(0,300) }
    });
  }
});

// Smoke test
app.get("/messages", (_req, res) =>
  res.status(200).json({ jsonrpc: "2.0", id: Date.now(), result: { ok: true, route: "direct" } })
);

// Debug
app.get("/debug/env", (_req, res) =>
  res.json({ node: process.versions.node, uptimeSec: process.uptime(), patch: "v6.5.7" })
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
app.get("/", (_req, res) => res.json({ service: "supabase-mcp", patch: "v6.5.7" }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(port, () => console.log(`MCP server listening on port ${port} (patch v6.5.7)`));
