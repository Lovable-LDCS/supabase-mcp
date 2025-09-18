// server.js — v6.5.8
// - Robust CORS preflight: app.options('*', cors()) mirrors requested headers
// - Logs Access-Control-Request-Headers on /messages preflight
// - Keeps: SSE transport with (req,res), JSON-RPC fallback, request logging

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { Server } from "@modelcontextprotocol/sdk/server";

const app = express();

// CORS: let the middleware handle preflights and echo requested headers.
app.use(cors({ origin: "*", methods: ["GET","POST","HEAD","OPTIONS"] }));
app.options("*", cors()); // <-- key: echoes Access-Control-Request-Headers automatically

app.use(express.json());

// Supabase env sanity
createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// MCP server (tools come later)
const mcpServer = new Server(
  { name: "supabase-mcp", version: "1.0.0" },
  { capabilities: {} }
);

// Helper to ensure non-preflight responses are permissive too
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
  // In non-preflight responses this header is optional, but harmless:
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Id, Authorization, Accept");
}

// ---- SSE transport resolver (covers multiple SDK layouts) ----
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

// ---- /sse lane ----
// Note: For GET /sse, do NOT write headers; the SDK handles them.
app.get("/sse", async (req, res) => {
  setCors(res);
  console.log("[SSE] incoming GET", { ua: req.get("user-agent") });
  const sse = await getSSEServerTransport();
  if (!sse.ok) {
    console.error("[SSE] transport resolve failed:", sse.err.join(" | "));
    return res.status(500).json({ error: "SSE transport not available", err: sse.err });
  }
  try {
    const transport = new sse.ctor(req, res); // emits endpoint hint /sse?sessionId=...
    await mcpServer.connect(transport);
    console.log("[SSE] connected via", sse.path);
  } catch (e) {
    console.error("[SSE] connect error:", e);
    if (!res.headersSent) return res.status(500).json({ error: String(e).slice(0,300) });
    try { res.end(); } catch {}
  }
});

// ---- /messages (preflight + JSON-RPC) ----
app.options("/messages", (req, res) => {
  // cors() already mirrored incoming headers; add logging for visibility
  const asked = req.get("access-control-request-headers") || "<none>";
  console.log("[/messages] preflight, requested headers:", asked);
  // Also ensure permissive headers are present (belt-and-suspenders)
  setCors(res);
  res.sendStatus(204);
});

app.post("/messages", async (req, res) => {
  try {
    setCors(res);
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
  res.json({ node: process.versions.node, uptimeSec: process.uptime(), patch: "v6.5.8" })
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
app.get("/", (_req, res) => res.json({ service: "supabase-mcp", patch: "v6.5.8" }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(port, () => console.log(`MCP server listening on port ${port} (patch v6.5.8)`));
