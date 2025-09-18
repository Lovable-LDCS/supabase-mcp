// server.js — v6.8.2
// - Force initialize to include actions capability (avoid SDK default that omits actions)
// - Keep: SSE GET via SDK, POST on /sse & /messages, explicit preflights, actions+tools stubs

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { Server } from "@modelcontextprotocol/sdk/server";

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","HEAD","OPTIONS"] }));
app.use(express.json());

createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const mcpServer = new Server(
  { name: "supabase-mcp", version: "1.0.0" },
  { capabilities: {} }
);

const PROTOCOL_VERSION = "2024-11-05";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Id, Authorization, Accept");
}

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
    } catch (e) { sseCache.err.push(`${p}: ${String(e).slice(0,180)}`); }
  }
  return sseCache;
}

// ----- /sse preflights + GET (SDK headers) -----
app.options("/sse", (req,res)=>{ const asked=req.get("access-control-request-headers")||"<none>"; console.log("[/sse] preflight headers:", asked); if(asked) res.setHeader("Access-Control-Allow-Headers", asked); setCors(res); res.sendStatus(204);});
app.head("/sse", (_req,res)=>{ setCors(res); res.status(200).end(); });
app.get("/sse", async (req,res)=>{
  setCors(res);
  console.log("[SSE] incoming GET", { ua: req.get("user-agent") });
  const sse = await getSSEServerTransport();
  if(!sse.ok) return res.status(500).json({ error:"SSE transport not available", err:sse.err });
  try { const transport = new sse.ctor(req,res); await mcpServer.connect(transport); console.log("[SSE] connected via", sse.path); }
  catch(e){ console.error("[SSE] connect error:", e); if(!res.headersSent) return res.status(500).json({ error:String(e).slice(0,300) }); try{res.end();}catch{} }
});

// ----- shared schema/defs -----
const SEARCH_INPUT_SCHEMA = {
  type:"object",
  properties:{
    query:{ type:"string", description:"What to search for." },
    topK:{ type:"integer", minimum:1, maximum:10, default:3 }
  },
  required:["query"]
};

const SEARCH_TOOL_DEF = {
  name:"search",
  description:"Simple text search (stub). Returns placeholder results; to be wired to Supabase.",
  input_schema: SEARCH_INPUT_SCHEMA
};

const SEARCH_ACTION_DEF = {
  name:"search",
  title:"Search",
  description:"Search across your data (stub).",
  input_schema: SEARCH_INPUT_SCHEMA,
  parameters: SEARCH_INPUT_SCHEMA
};

// ----- JSON-RPC handler for both /messages and /sse -----
async function handleJsonRpc(req,res){
  try{
    setCors(res);
    const body = req.body ?? {};
    const method = body.method || "<no-method>";
    const hasId = Object.prototype.hasOwnProperty.call(body,"id");
    const id = hasId ? body.id : undefined;
    const sid = req.get("x-session-id") || req.query.sessionId || "<none>";
    console.log(`[${req.path}]`, method, "sid=", sid);

    // notifications: ack
    if(!hasId || id === null){
      if(method === "notifications/initialized"){ console.log(`[${req.path}] notification ack`); return res.sendStatus(204); }
      return res.sendStatus(204);
    }

    // **Force our initialize** so actions are always advertised
    if(method === "initialize"){
      return res.status(200).json({
        jsonrpc:"2.0",
        id,
        result:{
          serverInfo:{ name:"supabase-mcp", version:"1.0.0" },
          protocolVersion: PROTOCOL_VERSION,
          capabilities:{ tools:{}, actions:{ search:{} } }
        }
      });
    }

    // Prefer SDK for other methods if available
    if(typeof mcpServer.handleHTTP === "function"){
      const out = await mcpServer.handleHTTP(body, { sessionId: sid !== "<none>" ? sid : undefined });
      if(out) return res.status(200).json(out);
    } else if(typeof mcpServer.handleRequest === "function"){
      const out = await mcpServer.handleRequest(body);
      if(out) return res.status(200).json(out);
    }

    // ----- Fallbacks -----
    if(method === "tools/list"){
      return res.status(200).json({ jsonrpc:"2.0", id, result:{ tools:[SEARCH_TOOL_DEF] }});
    }
    if(method === "tools/call"){
      const name = body.params?.name; const args = body.params?.arguments || {};
      if(name === "search"){
        const q = String(args.query || "").trim();
        const topK = Math.min(Math.max(parseInt(args.topK ?? 3,10)||3,1),10);
        const text = q ? `Search results for "${q}" (stub)\n- No database wired yet.\n- topK=${topK}` : `Search (stub): no query provided.`;
        return res.status(200).json({ jsonrpc:"2.0", id, result:{ content:[{ type:"text", text }] }});
      }
      return res.status(200).json({ jsonrpc:"2.0", id, error:{ code:-32601, message:`Tool ${name} not found` }});
    }

    if(method === "actions/list"){
      return res.status(200).json({ jsonrpc:"2.0", id, result:{ actions:[SEARCH_ACTION_DEF] }});
    }
    if(method === "actions/call"){
      const name = body.params?.name; const args = body.params?.arguments || {};
      if(name === "search"){
        const q = String(args.query || "").trim();
        const topK = Math.min(Math.max(parseInt(args.topK ?? 3,10)||3,1),10);
        const text = q ? `Search results for "${q}" (stub)\n- No database wired yet.\n- topK=${topK}` : `Search (stub): no query provided.`;
        return res.status(200).json({ jsonrpc:"2.0", id, result:{ content:[{ type:"text", text }] }});
      }
      return res.status(200).json({ jsonrpc:"2.0", id, error:{ code:-32601, message:`Action ${name} not found` }});
    }

    // default
    return res.status(200).json({ jsonrpc:"2.0", id, error:{ code:-32601, message:`Method ${method} not found` }});
  }catch(e){
    console.error(`[${req.path}] error:`, e);
    return res.status(200).json({ jsonrpc:"2.0", id:(req.body&&req.body.id)||null, error:{ code:-32000, message:String(e).slice(0,300) }});
  }
}

app.options("/messages", (req,res)=>{ const asked=req.get("access-control-request-headers")||"<none>"; console.log("[/messages] preflight headers:", asked); if(asked) res.setHeader("Access-Control-Allow-Headers", asked); setCors(res); res.sendStatus(204);});
app.post("/messages", handleJsonRpc);
app.post("/sse", handleJsonRpc);

app.get("/messages", (_req,res)=> res.status(200).json({ jsonrpc:"2.0", id:Date.now(), result:{ ok:true, route:"direct" }}));

app.get("/debug/env", (_req,res)=> res.json({ node:process.versions.node, uptimeSec:process.uptime(), patch:"v6.8.2" }));
app.get("/debug/sdk", async (_req,res)=>{ const details={ node:process.versions.node }; try{ const pkg=await import("@modelcontextprotocol/sdk/package.json",{ with:{ type:"json"}}); details.sdkVersion=pkg.default?.version||"unknown"; }catch{ details.sdkVersion="unavailable"; } const sse=await getSSEServerTransport(); details.sseResolved=sse.ok; details.ssePath=sse.path; details.errors=sse.err; res.json(details); });

const port = process.env.PORT || 3000;
app.get("/", (_req,res)=> res.json({ service:"supabase-mcp", patch:"v6.8.2" }));
app.use((_req,res)=> res.status(404).json({ error:"Not found" }));
app.listen(port, ()=> console.log(`MCP server listening on port ${port} (patch v6.8.2)`));
