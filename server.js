// server.js — v6.6.2
// - Add protocolVersion to JSON-RPC initialize result (client expects this)
// - Keep: SSE GET via SDK, POST /messages and POST /sse, explicit preflights, permissive CORS, path logging

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { Server } from "@modelcontextprotocol/sdk/server";

const app = express();

// CORS for all responses (simple)
app.use(cors({ origin: "*", methods: ["GET","POST","HEAD","OPTIONS"] }));
app.use(express.json());

// Supabase sanity
createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// MCP core
const mcpServer = new Server(
  { name: "supabase-mcp", version: "1.0.0" },
  { capabilities: {} }
);

// Report a modern protocol identifier; safe default for clients that require it.
const PROTOCOL_VERSION = "2024-11-05";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Id, Authorization, Accept");
}

// ---- SSE transport resolver ----
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

// ---- /sse: preflight + GET (SDK owns headers) + POST (JSON-RPC alias) ----
app.options("/sse", (req, res) => {
  const asked = req.get("access-control-request-headers") || "<none>";
  console.log("[/sse] preflight, requested headers:", asked);
  if (asked) res.setHeader("Access-Control-Allow-Headers", asked);
  setCors(res);
  res.sendStatus(204);
});
app.head("/sse", (_req, res) => { setCors(res); res.status(200).end(); });

app.get("/sse", async (req, res) => {
  setCors(res);
  console.log("[SSE] incoming GET", { ua: req.get("user-agent") });
  const sse = await getSSEServerTransport();
  if (!sse.ok) return res.status(500).json({ error: "SSE transport not available", err: sse.err });
  try {
    const transport = new sse.ctor(req, res); // emits endpoint: /sse?sessionId=...
    await mcpServer.connect(transport);
    console.log("[SSE] connected via", sse.path);
  } catch (e) {
    console.error("[SSE] connect error:", e);
    if (!res.headersSent) return res.status(500).json({ error: String(e).slice(0,300) });
    try { res.end(); } catch {}
  }
});

// ---- Shared JSON-RPC handler (used by both /messages and /sse) ----
async function handleJsonRpc(req, res) {
  try {
    setCors(res);
    const method = req.body?.method || "<no-method>";
    const sid = req.get("x-session-id") || req.query.sessionId || "<none>";
    console.log(`[${req.path}]`, method, "sid=", sid);

    const body = req.body ?? {};
    const id = body.id ?? null;

    // Prefer SDK helpers if present
    if (typeof mcpServer.handleHTTP === "function") {
      const sessionId = sid !== "<none>" ? sid : undefined;
      const out = await mcpServer.handleHTTP(body, { sessionId });
      console.log(`[${req.path}] -> handled by SDK (HTTP)`);
      return res.status(200).json(out ?? {});
    }
    if (typeof mcpServer.handleRequest === "function") {
      const out = await mcpServer.handleRequest(body);
      console.log(`[${req.path}] -> handled by SDK (handleRequest)`);
      return res.status(200).json(out ?? {});
    }

    // --- Minimal fallbacks for connector creation ---
    if (method === "initialize") {
      const payload = {
        jsonrpc: "2.0",
        id,
        result: {
          serverInfo: { name: "supabase-mcp", version: "1.0.0" },
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {}          // no tools yet; we'll add next
        }
      };
      console.log(`[${req.path}] -> 200 ${JSON.stringify(payload).slice(0, 140)}…`);
      return res.status(200).json(payload);
    }

    if (method === "tools/list") {
      const payload = { jsonrpc: "2.0", id, result: { tools: [] } };
      console.log(`[${req.path}] -> 200 ${JSON.stringify(payload).slice(0, 140)}…`);
      return res.status(200).json(payload);
    }

    const errPayload = {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method ${method} not found` }
    };
    console.log(`[${req.path}] -> 200 ${JSON.stringify(errPayload).slice(0, 140)}…`);
    return res.status(200).json(errPayload);

  } catch (e) {
    console.error(`[${req.path}] error:`, e);
    return res.status(200).json({
      jsonrpc: "2.0",
      id: (req.body && req.body.id) || null,
      error: { code: -32000, message: String(e).slice(0,300) }
    });
  }
}

// /messages canonical + explicit preflight
app.options("/messages", (req, res) => {
  const asked = req.get("access-control-request-headers") || "<none>";
  console.log("[/messages] preflight, requested headers:", asked);
  if (asked) res.setHeader("Access-Control-Allow-Headers", asked);
  setCors(res);
  res.sendStatus(204);
});
app.post("/messages", handleJsonRpc);

// /sse alias for JSON-RPC POST
app.post("/sse", handleJsonRpc);

// Smoke + debug
app.get("/messages", (_req, res) =>
  res.status(200).json({ jsonrpc: "2.0", id: Date.now(), result: { ok: true, route: "direct" } })
);
app.get("/debug/env", (_req, res) =>
  res.json({ node: process.versions.node, uptimeSec: process.uptime(), patch: "v6.6.2" })
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
app.get("/", (_req, res) => res.json({ service: "supabase-mcp", patch: "v6.6.2" }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(port, () => console.log(`MCP server listening on port ${port} (patch v6.6.2)`));
