// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

/* ---------------- App & Middleware ---------------- */
const app = express();

// Be explicit & permissive for ChatGPT connector
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Cache-Control",
      "Last-Event-ID",
    ],
    exposedHeaders: ["Content-Type"],
  })
);

// Global JSON parser with sane limit
app.use(express.json({ limit: "5mb" }));

// Valid, catch-all preflight handler (no bare "*")
app.options("(.*)", (req, res) => res.sendStatus(204));

/* ---------------- Supabase ---------------- */
const { SUPABASE_URL, SUPABASE_KEY } = process.env;
const supabase = createClient(SUPABASE_URL || "", SUPABASE_KEY || "", {
  auth: { persistSession: false },
});

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
    return {
      content: [
        { type: "text", text: JSON.stringify({ rows: data }, null, 2) },
      ],
    };
  }
);

server.registerTool(
  "sql.query",
  {
    title: "SQL query (RPC)",
    description:
      "Run a SQL query via the Postgres function public.exec_sql (read-only).",
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
    return {
      content: [
        { type: "text", text: JSON.stringify({ rows: data }, null, 2) },
      ],
    };
  }
);

/* ---------------- Legacy SSE transport endpoints ---------------- */
const sseTransports = /** @type {Record<string, SSEServerTransport>} */ ({});

// 1) Client opens SSE stream here
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
    if (!res.headersSent) res.status(500).end("SSE error");
  }
});

// 2) Client posts messages here, with ?sessionId=... (transport-managed)
app.options("/messages", cors());
app.post("/messages", express.json({ limit: "5mb" }), async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) {
    console.warn("[MSG] missing sessionId");
    return res.status(400).send("Missing sessionId");
  }
  const transport = sseTransports[sessionId];
  if (!transport) {
    console.warn(`[MSG] no transport for sessionId=${sessionId}`);
    return res.status(400).send("No transport found for sessionId");
  }
  try {
    const bytes = Buffer.byteLength(JSON.stringify(req.body) || "");
    console.log(`[MSG] in   sessionId=${sessionId} bytes=${bytes}`);
    await transport.handlePostMessage(req, res, req.body);
    console.log(`[MSG] out  sessionId=${sessionId} status=${res.statusCode}`);
  } catch (e) {
    console.error("[MSG] error", e);
    if (!res.headersSent) res.status(500).send("Internal error");
  }
});

/* ---------------- Health ---------------- */
app.get("/", (_req, res) => res.json({ ok: true }));

/* ---------------- Start & Shutdown ---------------- */
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const port = Number(process.env.PORT || 10000);
const serverHttp = app.listen(port, () =>
  console.log(`MCP listening on :${port}`)
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[shutdown] ${sig} received`);
    serverHttp.close(() => {
      console.log("[shutdown] HTTP server closed");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  });
}
