import express from 'express';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 10000;
const PATCH = "v6.9.8";

// Allowlist for ChatGPT
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ??
  "https://chat.openai.com,https://chatgpt.com")
  .split(",").map(s => s.trim()).filter(Boolean);

// ---------- CORS (dynamic; covers preflight too) ----------
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / server-to-server
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: [ "GET","POST","HEAD","OPTIONS" ],
  allowedHeaders: [ "Content-Type","X-Session-Id","Authorization","Accept" ],
  maxAge: 86400,
  optionsSuccessStatus: 204,
  preflightContinue: false, // cors auto-ends OPTIONS
};

app.use((req,res,next)=>{ res.setHeader("Vary","Origin"); next(); });
app.use(cors(corsOptions));
app.use(express.json());

// ---------- Diagnostics ----------
app.get("/", (_req, res) => res.json({ service: "supabase-mcp", patch: PATCH }));
app.get("/debug/env", (_req, res) =>
  res.json({ node: process.versions.node, uptimeSec: process.uptime(), patch: PATCH })
);

// ---------- Actions (spec expects 'search') ----------
const ACTIONS = [{
  name: "search",
  title: "Search",
  description: "Search across your data (stub).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for." },
      topK: { type: "integer", minimum: 1, maximum: 10, default: 3 }
    },
    required: ["query"]
  },
  // keep for compatibility with some clients:
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for." },
      topK: { type: "integer", minimum: 1, maximum: 10, default: 3 }
    },
    required: ["query"]
  }
}];

function noStore(res) {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma","no-cache");
  res.setHeader("Expires","0");
}

// REST list (three paths)
function actionsList(_req, res) { noStore(res); res.json({ actions: ACTIONS }); }
app.get("/actions/list", actionsList);
app.get("/sse/actions/list", actionsList);
app.get("/messages/actions/list", actionsList);

// REST call
app.post("/actions/call", (req, res) => {
  noStore(res);
  const { name, arguments: args } = req.body || {};
  if (name !== "search") return res.status(404).json({ error: "Unknown action" });
  const q = (args?.query ?? "").toString();
  const topK = Number.isInteger(args?.topK) ? args.topK : 3;
  return res.json({
    content: [{ type: "text", text: Search results for "" (stub)\n- No database wired yet.\n- topK= }]
  });
});

// ---------- JSON-RPC over /sse (HTTP POST) ----------
app.post("/sse", (req, res) => {
  noStore(res);
  const { id, method } = req.body || {};
  const json = (result) => res.json({ jsonrpc: "2.0", id, result });
  const error = (code, message) => res.json({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    return json({
      serverInfo: { name: "supabase-mcp", version: "1.0.0" },
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, actions: {} },
    });
  }
  if (method === "tools/list") return json({ tools: [] });
  if (method === "actions/list") return json({ actions: ACTIONS });

  return error(-32601, "Method not found");
});

// ---------- Start ----------
app.listen(port, () => console.log(\MCP server listening on port \ (patch \)\));
