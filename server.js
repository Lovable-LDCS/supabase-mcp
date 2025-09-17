import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();

// --- CORS: be explicit & permissive for ChatGPT connector ---
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "Cache-Control",
    "Last-Event-ID"
  ],
  exposedHeaders: ["Content-Type"],
}));

// Global JSON parser; bump size in case payloads get large
app.use(express.json({ limit: "5mb" }));

// Quick preflight path for safety
app.options("*", (req, res) => res.sendStatus(204));

/* ---------------- Auth disabled for connector testing ---------------- */
app.use((req, res, next) => next());

/* ---------------- Supabase client ---------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

/* ---------------- MCP Server & Tools ---------------- */
const server = new McpServer({ name: "supabase-mcp", version: "1.0.0" });

server.registerTool(
  "db.rows",
  {
    title: "List table rows",
    description: "Fetch rows from a table with limit/offset.",
    inputSchema: z.object({
      table: z.string().describe("Table name, e.g., public.users"),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
    }),
  },
  async ({ table, limit = 50, offset = 0 }) => {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(offset, offset + limit - 1);

    if (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Supabase error: ${error.message}` }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify({ rows: data }, null, 2) }] };
  }
);

server.registerTool(
  "sql.query",
  {
    title: "SQL query (RPC)",
    description: "Run a SQL query via the Postgres function public.exec_sql (read-only).",
    inputSchema: z.object({
      sql: z.string().describe("SQL to execute (use SELECT for read-only)."),
      params: z.array(z.any()).default([]).describe("Optional positional params"),
    }),
  },
  async ({ sql, params = [] }) => {
    const { data, error } = await supabase.rpc("exec_sql", { sql, params });
    if (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Supabase RPC error: ${error.message}` }],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify({ rows: data }, null, 2) }] };
  }
);

/* ---------------- Legacy SSE transport endpoints ---------------- */
const sseTransports = /** @type {Record<string, SSEServerTransport>} */ ({});

app.get("/sse", async (req, res) => {
  try {
    const transport = new SSEServerTransport("/messages", res);
    sseTransports[transport.sessionId] = transport;
    console.log(`[SSE] open  sessionId=${transport.sessionId}`);

    res.on("close", () => {
      console.log(`[SSE] close sessionId=${transport.sessionId}`);
      delete sseTransports[transport.sessionId];
    });

    await server.connect(transport);
  } catch (e) {
    console.error("[SSE] error", e);
  }
});

// Tighten parser specifically for /messages too (belt & suspenders)
app.options("/messages", (req, res) => res.sendStatus(204));

app.post("/messages", express.json({ limit: "5mb" }), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports[sessionId];
  if (!transport) {
    console.warn(`[MSG] no transport for sessionId=${sessionId}`);
    res.status(400).send("No transport found for sessionId");
    return;
  }
  try {
    console.log(`[MSG] in   sessionId=${sessionId} bytes=${Buffer.byteLength(JSON.stringify(req.body) || "")}`);
    await transport.handlePostMessage(req, res, req.body);
    console.log(`[MSG] out  sessionId=${sessionId} status=${res.statusCode}`);
  } catch (e) {
    console.error("[MSG] error", e);
    if (!res.headersSent) res.status(500).send("Internal error");
  }
});

/* ---------------- Health check ---------------- */
app.get("/", (_, res) => res.json({ ok: true }));

/* ---------------- Start ---------------- */
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log(`MCP listening on :${port}`));
