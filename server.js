// server.js — v6.8.1
// - Action compatibility shim: add title + parameters to actions
// - Advertise actions explicitly in initialize.capabilities
// - Keep: SSE GET via SDK, POST on /sse & /messages, explicit preflights,
//         permissive CORS, logging, notifications

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { Server } from "@modelcontextprotocol/sdk/server";

const app = express();

// CORS for all responses
app.use(cors({ origin: "*", methods: ["GET","POST","HEAD","OPTIONS"] }));
app.use(express.json());

// Supabase sanity
createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// MCP core
const mcpServer = new Server(
  { name: "supabase-mcp", version: "1.0.0" },
  { capabilities: {} }
);

// Protocol version the UI expects
const PROTOCOL_VERSION = "2024-11-05";

// Common CORS helper
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Id, Authorization, Accept");
}

// ---- Resolve SSE transport across SDK layouts ----
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

// ---- /sse: preflight + GET (SDK headers) + POST (JSON-RPC alias) ----
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
    const transport = new sse.ctor(req, res); // emits endpoint hint /sse?sessionId=...
    await mcpServer.connect(transport);
    console.log("[SSE] connected via", sse.path);
  } catch (e) {
    console.error("[SSE] connect error:", e);
    if (!res.headersSent) return res.status(500).json({ error: String(e).slice(0,300) });
    try { res.end(); } catch {}
  }
});

// ---- Tool + Action definitions (mirrored) ----
const SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "What to search for." },
    topK:  { type: "integer", minimum: 1, maximum: 10, default: 3 }
  },
  required: ["query"]
};

const SEARCH_TOOL_DEF = {
  name: "search",
  description: "Simple text search (stub). Returns placeholder results; to be wired to Supabase.",
  input_schema: SEARCH_INPUT_SCHEMA
};

const SEARCH_ACTION_DEF = {
  name: "search",
  title: "Search",                       // <-- added
  description: "Search across your data (stub).",
  input_schema: SEARCH_INPUT_SCHEMA,
  parameters: SEARCH_INPUT_SCHEMA        // <-- added alias some clients expect
};

// ---- Shared JSON-RPC handler (used by both /messages and /sse) ----
async function handleJsonRpc(req, res) {
  try {
    setCors(res);
    const method = req.body?.method || "<no-method>";
    const hasId   = Object.prototype.hasOwnProperty.call(req.body || {}, "id");
    const id      = hasId ? req.body.id : undefined;
    const sid     = req.get("x-session-id") || req.query.sessionId || "<none>";
    console.log(`[${req.path}]`, method, "sid=", sid);

    // Notifications (no id): acknowledge with 204
    if (!hasId || id === null) {
      if (method === "notifications/initialized") {
        console.log(`[${req.path}] notification acknowledged: ${method}`);
        return res.sendStatus(204);
      }
      console.log(`[${req.path}] notification ignored: ${method}`);
      return res.sendStatus(204);
    }

    const body = req.body ?? {};

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

    // ---------- Minimal fallbacks ----------

    // Initialize: now explicitly advertise the actions we support
    if (method === "initialize") {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: {
          serverInfo: { name: "supabase-mcp", version: "1.0.0" },
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            actions: { search: {} }    // <-- explicitly list supported action(s)
          }
        }
      });
    }

    // --- Tools API ---
    if (method === "tools/list") {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: { tools: [SEARCH_TOOL_DEF] }
      });
    }

    if (method === "tools/call") {
      const name = body.params?.name;
      const args = body.params?.arguments || {};
      if (name === "search") {
        const q = String(args.query || "").trim();
        const topK = Math.min(Math.max(parseInt(args.topK ?? 3, 10) || 3, 1), 10);
        const text = q
          ? `Search results for "${q}" (stub)\n- No database wired yet.\n- topK=${topK}\n- Next step: connect Supabase and return real rows.`
          : `Search (stub): no query provided.`;
        return res.status(200).json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }] }
        });
      }
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Tool ${name} not found` }
      });
    }

    // --- Actions API (mirrors tools) ---
    if (method === "actions/list") {
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: { actions: [SEARCH_ACTION_DEF] }
      });
    }

    if (method === "actions/call") {
      const name = body.params?.name;
      const args = body.params?.arguments || {};
      if (name === "search") {
        const q = String(args.query || "").trim();
        const topK = Math.min(Math.max(parseInt(args.topK ?? 3, 10) || 3, 1), 10);
        const text = q
          ? `Search results for "${q}" (stub)\n- No database wired yet.\n- topK=${topK}`
          : `Search (stub): no query provided.`;
        return res.status(200).json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }] }
        });
      }
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Action ${name} not found` }
      });
    }

    // Default: method not found
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method ${method} not found` }
    });

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
  res.json({ node: process.versions.node, uptimeSec: process.uptime(), patch: "v6.8.1" })
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
app.get("/", (_req, res) => res.json({ service: "supabase-mcp", patch: "v6.8.1" }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(port, () => console.log(`MCP server listening on port ${port} (patch v6.8.1)`));
