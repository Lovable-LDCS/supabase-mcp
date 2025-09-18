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
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
}

let sseCache = { ok:false, path:null, ctor:null, err:[] };
async function getSSEServerTransport() {
  if (sseCache.ok) return sseCache;
  const paths = [
    "@modelcontextprotocol/sdk/server/sse.js",
    "@modelcontextprotocol/sdk/server/transport/sse.js",
    "@modelcontextprotocol/sdk/transport/sse.js",
    "@modelcontextprotocol/sdk/server/sse",
    "@modelcontextprotocol/sdk/server/transport/sse",
    "@modelcontextprotocol/sdk/transport/sse",
  ];
  for (const p of paths) {
    try {
      const m = await import(p);
      const ctor = m.SSEServerTransport || m.default || m.SSE;
      if (ctor) { sseCache = { ok:true, path:p, ctor, err:[] }; return sseCache; }
      sseCache.err.push(\Found \ but no SSEServerTransport export\);
    } catch (e) {
      sseCache.err.push(\\: \\);
    }
  }
  return sseCache;
}

/* ---------------------- SSE ---------------------- */
app.options("/sse", (req,res)=>{ const asked=req.get("access-control-request-headers")||"<none>"; console.log("[/sse] preflight", asked); if(asked) res.setHeader("Access-Control-Allow-Headers", asked); setCors(res); res.sendStatus(204); });
app.head("/sse", (_req,res)=>{ setCors(res); res.status(200).end(); });
app.get("/sse", async (req,res)=>{
  setCors(res);
  console.log("[SSE] incoming GET", { ua: req.get("user-agent") });
  const sse = await getSSEServerTransport();
  if(!sse.ok) return res.status(500).json({ error:"SSE transport not available", err:sse.err });
  try { const transport = new sse.ctor(req,res); await mcpServer.connect(transport); console.log("[SSE] connected via", sse.path); }
  catch(e){ console.error("[SSE] connect error:", e); if(!res.headersSent) return res.status(500).json({ error:String(e).slice(0,300) }); try{res.end();}catch{} }
});

/* ----------------- shared schema/defs ----------------- */
const SEARCH_INPUT_SCHEMA = {
  type:"object",
  properties:{
    query:{ type:"string", description:"What to search for." },
    topK:{ type:"integer", minimum:1, maximum:10, default:3 }
  },
  required:["query"]
};
const SEARCH_TOOL_DEF = { name:"search", description:"Simple text search (stub). Returns placeholder results; to be wired to Supabase.", input_schema: SEARCH_INPUT_SCHEMA };
const SEARCH_ACTION_DEF = { name:"search", title:"Search", description:"Search across your data (stub).", input_schema: SEARCH_INPUT_SCHEMA, parameters: SEARCH_INPUT_SCHEMA };

/* ---------------- JSON-RPC handlers ---------------- */
async function handleJsonRpc(req,res){
  try{
    setCors(res);
    const body = req.body ?? {};
    const method = body.method || "<no-method>";
    const hasId = Object.prototype.hasOwnProperty.call(body,"id");
    const id = hasId ? body.id : undefined;
    const sid = req.get("x-session-id") || req.query.sessionId || "<none>";
    console.log(\[\]\, method, "sid=", sid);

    // notifications → ack
    if(!hasId || id === null){
      if(method === "notifications/initialized"){ console.log(\[\] notification ack\); return res.sendStatus(204); }
      return res.sendStatus(204);
    }

    // Always advertise actions
    if(method === "initialize"){
      return res.status(200).json({
        jsonrpc: "2.0",
        id,
        result: {
          serverInfo: { name: "supabase-mcp", version: "1.0.0" },
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools:{}, actions: { search:{} } }
        }
      });
    }

    // ✅ Short-circuit tools/* so the SDK can't return an empty list
    if(method === "tools/list"){
      console.log(\[\] tools/list -> 1 tool\);
      return res.status(200).json({ jsonrpc:"2.0", id, result:{ tools:[SEARCH_TOOL_DEF] }});
    }
    if(method === "tools/call"){
      const { name } = body.params || {};
      const args = body.params?.arguments || {};
      if(name === "search"){
        const q = String(args.query || "").trim();
        const topK = Math.min(Math.max(parseInt(args.topK ?? 3,10)||3,1),10);
        const text = q ? \Search results for "\" (stub)\n- No database wired yet.\n- topK=\\ : \Search (stub): no query provided.\;
        return res.status(200).json({ jsonrpc:"2.0", id, result:{ content:[{ type:"text", text }] }});
      }
      return res.status(200).json({ jsonrpc:"2.0", id, error:{ code:-32601, message:\Tool \ not found\ }});
    }

    // Prefer SDK for anything else
    if(typeof mcpServer.handleHTTP === "function"){
      const out = await mcpServer.handleHTTP(body, { sessionId: sid !== "<none>" ? sid : undefined });
      if(out) return res.status(200).json(out);
    } else if(typeof mcpServer.handleRequest === "function"){
      const out = await mcpServer.handleRequest(body);
      if(out) return res.status(200).json(out);
    }

    // Fallbacks for actions/*
    if(method === "actions/list") return res.status(200).json({ jsonrpc:"2.0", id, result:{ actions:[SEARCH_ACTION_DEF] }});
    if(method === "actions/call"){
      const { name } = body.params || {};
      const args = body.params?.arguments || {};
      if(name === "search"){
        const q = String(args.query || "").trim();
        const topK = Math.min(Math.max(parseInt(args.topK ?? 3,10)||3,1),10);
        const result = { content:[{ type:"text", text: q ? \Search results for "\" (stub)\n- No database wired yet.\n- topK=\\ : \Search (stub): no query provided.\ }] };
        return res.status(200).json({ jsonrpc:"2.0", id, result });
      }
      return res.status(200).json({ jsonrpc:"2.0", id, error:{ code:-32601, message:\Action \ not found\ }});
    }

    return res.status(200).json({ jsonrpc:"2.0", id, error:{ code:-32601, message:\Method \ not found\ }});
  }catch(e){
    console.error(\[\] error:\, e);
    return res.status(200).json({ jsonrpc:"2.0", id:(req.body&&req.body.id)||null, error:{ code:-32000, message:String(e).slice(0,300) }});
  }
}
app.options("/messages", (req,res)=>{ const asked=req.get("access-control-request-headers")||"<none>"; console.log("[/messages] preflight", asked); if(asked) res.setHeader("Access-Control-Allow-Headers", asked); setCors(res); res.sendStatus(204); });
app.post("/messages", handleJsonRpc);
app.post("/sse", handleJsonRpc);

/* ------------- REST Actions shim (+aliases under /sse and /messages) ------------- */
function preflight(path){
  return (req,res)=>{
    const asked=req.get("access-control-request-headers")||"<none>";
    console.log(\[\] preflight\, asked);
    if(asked) res.setHeader("Access-Control-Allow-Headers", asked);
    setCors(res);
    res.sendStatus(204);
  };
}
function headOk(_req,res){ setCors(res); res.status(200).end(); }

function restListHandler(_req, res) {
  setCors(res);
  const result = { actions: [SEARCH_ACTION_DEF] };
  res.status(200).json({ ...result, jsonrpc: "2.0", id: 0, result });
}

function restCallHandler(name, args, res){
  if(name === "search"){
    const q = String(args.query || "").trim();
    const topK = Math.min(Math.max(parseInt(args.topK ?? 3,10)||3,1),10);
    const result = {
      content:[{ type:"text", text: q
        ? \Search results for "\" (stub)\n- No database wired yet.\n- topK=\\
        : \Search (stub): no query provided.\ }]
    };
    return res.status(200).json({ ...result, jsonrpc:"2.0", id:0, result });
  }
  return res.status(404).json({
    error:\Action \ not found\,
    jsonrpc:"2.0", id:0,
    errorRPC:{ code:-32601, message:\Action \ not found\ }
  });
}

/* Root REST endpoints: /actions/* */
app.options("/actions",        preflight("/actions"));
app.options("/actions/list",   preflight("/actions/list"));
app.options("/actions/call",   preflight("/actions/call"));
app.head   ("/actions",        headOk);
app.head   ("/actions/list",   headOk);
app.head   ("/actions/call",   headOk);

app.get ("/actions",       restListHandler);
app.get ("/actions/list",  restListHandler);
app.post("/actions/list",  restListHandler);

// GET /actions/call?name=search&arguments={"query":"x","topK":2}
app.get("/actions/call", (req,res)=>{
  setCors(res);
  const name = String(req.query.name||"").trim();
  let args = {};
  if (typeof req.query.arguments === "string") {
    try { args = JSON.parse(req.query.arguments); } catch { args = {}; }
  }
  console.log("[/actions] call (REST:GET)", { name });
  return restCallHandler(name, args, res);
});

app.post("/actions/call", (req,res)=>{
  setCors(res);
  const name = req.body?.name;
  const args = req.body?.arguments || {};
  console.log("[/actions] call (REST:POST)", { name });
  return restCallHandler(name, args, res);
});

/* Aliases so clients that append to /sse or /messages also work */
function wireActionsAliases(prefix) {
  app.options(\\/actions\,      preflight(\\/actions\));
  app.options(\\/actions/list\, preflight(\\/actions/list\));
  app.options(\\/actions/call\, preflight(\\/actions/call\));
  app.head   (\\/actions\,      headOk);
  app.head   (\\/actions/list\, headOk);
  app.head   (\\/actions/call\, headOk);

  app.get (\\/actions\,      restListHandler);
  app.get (\\/actions/list\, restListHandler);

  app.get (\\/actions/call\, (req,res)=>{
    setCors(res);
    const name = String(req.query.name||"").trim();
    let args = {};
    if (typeof req.query.arguments === "string") {
      try { args = JSON.parse(req.query.arguments); } catch { args = {}; }
    }
    console.log(\[\] actions/call (REST:GET)\, { name });
    return restCallHandler(name, args, res);
  });

  app.post(\\/actions/call\, (req,res)=>{
    setCors(res);
    const name = req.body?.name;
    const args = req.body?.arguments || {};
    console.log(\[\] actions/call (REST:POST)\, { name });
    return restCallHandler(name, args, res);
  });
}

wireActionsAliases("/sse");
wireActionsAliases("/messages");

/* ---------------- diagnostics + root ---------------- */
app.get("/messages", (_req,res)=> res.status(200).json({ jsonrpc:"2.0", id:Date.now(), result:{ ok:true, route:"direct" }}));
app.get("/debug/env", (_req,res)=> res.json({ node:process.versions.node, uptimeSec:process.uptime(), patch:"v6.9.4" }));
app.get("/debug/sdk", async (_req,res)=>{ const details={ node:process.versions.node }; try{ const pkg=await import("@modelcontextprotocol/sdk/package.json",{ with:{ type:"json"}}); details.sdkVersion=pkg.default?.version||"unknown"; }catch{ details.sdkVersion="unavailable"; } const sse=await getSSEServerTransport(); details.sseResolved=sse.ok; details.ssePath=sse.path; details.errors=sse.err; res.json(details); });

const port = process.env.PORT || 3000;
app.get("/", (_req,res)=> res.json({ service:"supabase-mcp", patch:"v6.9.4" }));
app.use((_req,res)=> { setCors(res); res.status(404).json({ error:"Not found" }); });

app.listen(port, ()=> console.log(\MCP server listening on port \ (patch v6.9.4)\));