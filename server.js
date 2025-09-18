import express from "express";
import cors from "cors";

const app = express();
const port = process.env.PORT || 10000;
const PATCH = "v6.9.9";

/* --------- Dynamic CORS (covers preflight) ---------- */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ??
  "https://chat.openai.com,https://chatgpt.com")
  .split(",").map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                // curl / server-to-server
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET","POST","HEAD","OPTIONS"],
  allowedHeaders: ["Content-Type","X-Session-Id","Authorization","Accept"],
  maxAge: 86400,
  optionsSuccessStatus: 204,
  preflightContinue: false
};

app.use((req,res,next)=>{ res.setHeader("Vary","Origin"); next(); });
app.use(cors(corsOptions));
app.use(express.json());

/* ------------- Diagnostics ------------- */
app.get("/", (_req, res) => res.json({ service: "supabase-mcp", patch: PATCH }));
app.get("/debug/env", (_req, res) =>
  res.json({ node: process.versions.node, uptimeSec: process.uptime(), patch: PATCH })
);

/* ------------- Actions (REST) ------------- */
const ACTION_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "What to search for." },
    topK:  { type: "integer", minimum: 1, maximum: 10, default: 3 }
  },
  required: ["query"]
};

const ACTIONS = [{
  name: "search",
  title: "Search",
  description: "Search across your data (stub).",
  parameters: ACTION_SCHEMA,
  input_schema: ACTION_SCHEMA   // keep for older clients
}];

function noStore(res){
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma","no-cache");
  res.setHeader("Expires","0");
}

function actionsList(_req, res){ noStore(res); res.json({ actions: ACTIONS }); }
app.get("/actions/list", actionsList);
app.get("/sse/actions/list", actionsList);
app.get("/messages/actions/list", actionsList);

app.post("/actions/call", (req, res) => {
  noStore(res);
  const body = req.body || {};
  const name = body.name;
  const args = body.arguments || {};
  if (name !== "search") return res.status(404).json({ error: "Unknown action" });

  const q = (args.query || "").toString();
  const topK = Number.isInteger(args.topK) ? args.topK : 3;
  const text = 'Search results for "' + q.replace(/"/g, '\\"') + '" (stub)\n'
             + '- No database wired yet.\n'
             + '- topK=' + topK;
  return res.json({ content: [{ type: "text", text }] });
});

/* ------------- JSON-RPC over /sse (HTTP POST) ------------- */
/* The UI sometimes uses this to probe capabilities. */
app.post("/sse", (req, res) => {
  noStore(res);
  const body = req.body || {};
  const id = Object.prototype.hasOwnProperty.call(body,"id") ? body.id : null;
  const method = body.method || "";
  const respond = (obj) => res.json({ jsonrpc: "2.0", id, ...obj });

  if (method === "initialize") {
    return respond({
      result: {
        serverInfo: { name: "supabase-mcp", version: "1.0.0" },
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, actions: {} }
      }
    });
  }
  if (method === "tools/list")   return respond({ result: { tools: [] } });
  if (method === "actions/list") return respond({ result: { actions: ACTIONS } });

  return respond({ error: { code: -32601, message: "Method not found" }});
});

/* ------------- Start ------------- */
app.listen(port, () => {
  console.log("MCP server listening on port " + port + " (patch " + PATCH + ")");
});
