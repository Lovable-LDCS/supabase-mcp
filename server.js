import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { Server } from "@modelcontextprotocol/sdk/server";

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","HEAD","OPTIONS"] }));
app.use(express.json());

// Supabase (not yet used by stub search)
createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// MCP server (SDK)
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

/* -------- Resolve SSE transport across SDK layouts -------- */
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
      sseCache.err.push("Found " + p + " but no SSEServerTransport export");
    } catch (e) {
      sseCache.err.push(p + ": " + String(e).slice(0,180));
    }
  }
  return sseCache;
}

/* ----------------------- SSE endpoint --------------------- */
app.options("/sse", (req,res)=>{ const asked=req.get("access-control-request-headers")||"<none>"; console.log("[/sse] preflight", asked); if(asked) res.setHeader("Access-Control-Allow-Headers", asked); setCors(res); res.sendStatus(204); });
app.head("/sse", (_req,res)=>{ setCors(res); res.status(200).end(); });
app.get("/sse", async (req,res)=>{
  setCors(res);
  console.log("[SSE] incoming GET", { ua: req.get("user-agent") });
  const sse = await getSSEServerTransport();
  if(!sse.ok) return res.status(500).json({ error:"SSE transport not available", err:sse.err });
  try {
    const transport = new sse.ctor(req,res);
    await mcpServer.connect(transport);
    console.log("[SSE] connected via", sse.path);
  } catch(e){
    console.error("[SSE] connect error:", e);
    if(!res.headersSent) return res.status(500).json({ error:String(e).slice(0,300) });
    try{ res.end(); } catch(_){}
  }
});

/* ---------------- Shared schema/defs (search) -------------- */
const SEARCH_INPUT_SCHEMA = {
  type:"object",
  properties:{
    query:{ type:"string", description:"What to search for." },
    topK:{ type:"integer", minimum:1, maximum:10, default:3 }
  },
  required:["query"]
};
const SEARCH_TOOL_DEF   = { name:"search", description:"Simple text search (stub). Returns placeholder results; to be wired to Supabase.", input_schema: SEARCH_INPUT_SCHEMA };
const SEARCH_ACTION_DEF = { name:"search", title:"Search", description:"Search across your data (stub).", input_schema: SEARCH_INPUT_SCHEMA, parameters: SEARCH_INPUT_SCHEMA };

/* ---------------------- JSON-RPC handler ------------------- */
async function handleJsonRpc(req,res){
  try{
    setCors(res);
    const body = req.body ?? {};
    const method = body.method || "<no-method>";
    const hasId = Object.prototype.hasOwnProperty.call(body,"id");
    const id = hasId ? body.id : undefined;
    const sid = req.get("x-session-id") || req.query.sessionId || "<none>";
    console.log("[" + req.path + "]", method, "sid=", sid);

    // notifications → ack
    if(!hasId || id === null){
      if(method === "notifications/initialized"){ console.log("[" + req.path + "] notification ack"); return res.sendStatus(204); }
      return res.sendStatus(204);
    }

    // Capabilities
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

    // Intercept tools/*
    if(method === "tools/list"){
      console.log("[" + req.path + "] tools/list -> 1 tool");
      return res.status(200).json({ jsonrpc:"2.0", id, result:{ tools:[SEARCH_TOOL_DEF] }});
    }
    if(method === "tools/call"){
      const name = (body.params && body.params.name) || (body.params && body.params.toolName);
      const args = (body.params && (body.params.arguments || body.params.args)) || {};
      if(name === "search"){
        const q = String(args.query || "").trim();
        const topK = Math.min(Math.max(parseInt(args.topK ?? 3,10)||3,1),10);
        const text = q
          ? 'Search results for "' + q + '" (stub)\n- No database wired yet.\n- topK=' + topK
          : "Search (stub): no query provided.";
        return res.status(200).json({ jsonrpc:"2.0", id, result:{ content:[{ type:"text", text }] }});
      }
      return res.status(200).json({ jsonrpc:"2.0", id, error:{ code:-32601, message:"Tool " + name + " not found" }});
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
      const name = (body.params && body.params.name) || "";
      const args = (body.params && body.params.arguments) || {};
      if(name === "search"){
        const q = String(args.query || "").trim();
        const topK = Math.min(Math.max(parseInt(args.topK ?? 3,10)||3,1),10);
        const result = { content:[{ type:"text", text: q ? 'Search results for "' + q + '" (stub)\n- No database wired yet.\n- topK=' + topK : "Search (stub): no query provided." }] };
        return res.status(200).json({ jsonrpc:"2.0", id, result });
      }
      return res.status(200).json({ jsonrpc:"2.0", id, error:{ code:-32601, message:"Action " + name + " not found" }});
    }

    return res.status(200).json({ jsonrpc:"2.0", id, error:{ code:-32601, message:"Method " + method + " not found" }});
  }catch(e){
    console.error("[" + req.path + "] error:", e);
    return res.status(200).json({ jsonrpc:"2.0", id:(req.body&&req.body.id)||null, error:{ code:-32000, message:String(e).slice(0,300) }});
  }
}
app.options("/messages", (req,res)=>{ const asked=req.get("access-control-request-headers")||"<none>"; console.log("[/messages] preflight", asked); if(asked) res.setHeader("Access-Control-Allow-Headers", asked); setCors(res); res.sendStatus(204); });
app.post("/messages", handleJsonRpc);
app.post("/sse", handleJsonRpc);

/* -------- REST Actions shim (+aliases under /sse and /messages) -------- */
function preflight(path){ return (req,res)=>{ const asked=req.get("access-control-request-headers")||"<none>"; console.log("[" + path + "] preflight", asked); if(asked) res.setHeader("Access-Control-Allow-Headers", asked); setCors(res); res.sendStatus(204); }; }
function headOk(_req,res){ setCors(res); res.status(200).end(); }

function restListHandler(req, res) {
  setCors(res);
  console.log("[" + req.path + "] actions/list (REST)");
  // v6.9.6: **pure REST** (no jsonrpc/id/result)
  res.status(200).json({ actions: [SEARCH_ACTION_DEF] });
}
function restCallHandler(name, args, req, res){
  console.log("[" + req.path + "] actions/call (REST)", { name });
  if(name === "search"){
    const q = String(args.query || "").trim();
    const topK = Math.min(Math.max(parseInt(args.topK ?? 3,10)||3,1),10);
    // v6.9.6: **pure REST** (no jsonrpc/id/result)
    return res.status(200).json({
      content:[{ type:"text", text: q ? 'Search results for "' + q + '" (stub)\n- No database wired yet.\n- topK=' + topK : "Search (stub): no query provided." }]
    });
  }
  return res.status(404).json({ error:"Action " + name + " not found" });
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
app.get ("/actions/call", (req,res)=>{ setCors(res); const name=String(req.query.name||"").trim(); let args={}; if(typeof req.query.arguments==="string"){ try{ args=JSON.parse(req.query.arguments); }catch{} } return restCallHandler(name,args,req,res); });
app.post("/actions/call", (req,res)=>{ setCors(res); const name=req.body?.name; const args=req.body?.arguments||{}; return restCallHandler(name,args,req,res); });

/* Aliases so clients that append to /sse or /messages also work */
function wireActionsAliases(prefix) {
  app.options(prefix + "/actions",      preflight(prefix + "/actions"));
  app.options(prefix + "/actions/list", preflight(prefix + "/actions/list"));
  app.options(prefix + "/actions/call", preflight(prefix + "/actions/call"));
  app.head   (prefix + "/actions",      headOk);
  app.head   (prefix + "/actions/list", headOk);
  app.head   (prefix + "/actions/call", headOk);

  // LIST handlers (GET + POST)
  app.get (prefix + "/actions",      restListHandler);
  app.get (prefix + "/actions/list", restListHandler);
  app.post(prefix + "/actions/list", restListHandler);

  // CALL handlers
  app.get (prefix + "/actions/call", (req,res)=>{ setCors(res); const name=String(req.query.name||"").trim(); let args={}; if(typeof req.query.arguments==="string"){ try{ args=JSON.parse(req.query.arguments); }catch{} } return restCallHandler(name,args,req,res); });
  app.post(prefix + "/actions/call", (req,res)=>{ setCors(res); const name=req.body?.name; const args=req.body?.arguments||{}; return restCallHandler(name,args,req,res); });
}
wireActionsAliases("/sse");
wireActionsAliases("/messages");

/* -------------------- diagnostics + root -------------------- */
app.get("/messages", (_req,res)=> res.status(200).json({ jsonrpc:"2.0", id:Date.now(), result:{ ok:true, route:"direct" }}));
app.get("/debug/env", (_req,res)=> res.json({ node:process.versions.node, uptimeSec:process.uptime(), patch:"v6.9.6" }));
app.get("/debug/sdk", async (_req,res)=>{
  const details={ node:process.versions.node };
  try{ const pkg=await import("@modelcontextprotocol/sdk/package.json",{ with:{ type:"json"} }); details.sdkVersion=pkg.default?.version||"unknown"; }
  catch{ details.sdkVersion="unavailable"; }
  const sse=await getSSEServerTransport();
  details.sseResolved=sse.ok; details.ssePath=sse.path; details.errors=sse.err;
  res.json(details);
});

const port = process.env.PORT || 3000;
app.get("/", (_req,res)=> res.json({ service:"supabase-mcp", patch:"v6.9.6" }));
app.use((_req,res)=> { setCors(res); res.status(404).json({ error:"Not found" }); });
app.listen(port, ()=> console.log("MCP server listening on port " + port + " (patch v6.9.6)"));