import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* ---------------- Auth disabled for connector testing ---------------- */
app.use((req, res, next) => next());

/* ---------------- Supabase client ---------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { auth: { persistSession: false } }
);

/* ---------------- MCP Server & Tools ---------------- */
const server = new McpServer({
  name: "supabase-mcp",
  version: "1.0.0"
});

/** Tool: list rows from a table */
server.registerTool(
  "db.rows",
  {
    title: "List table rows",
    description: "Fetch rows from a table with limit/offset.",
    inputSchema: z.object({
      table: z.string().describe("Table name, e.g., public.users"),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0)
    })
  },
  async ({ table, limit = 50, offset = 0 }) => {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(offset, offset + limit - 1);

    if (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Supabase error: ${error.message}` }]
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ rows: data }, null, 2) }]
    };
  }
);

/** Tool: run SQL via RPC helper (add exec_sql in DB) */
server.registerTool(
  "sql.query",
  {
    title: "SQL query (RPC)",
    description:
      "Run a SQL query via the Postgres function public.exec_sql (read-only recommended).",
    inputSchema: z.object({
      sql: z.string().describe("SQL to execute (use SELECT for read-only)."),
      params: z.array(z.any()).default([]).describe("Optional positional params")
    })
  },
  async ({ sql, params = [] }) => {
    const { data, error } = await supabase.rpc("exec_sql", { sql, params });
    if (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Supabase RPC error: ${error.message}` }]
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ rows: data }, null, 2) }]
    };
  }
);

/* ---------------- Legacy SSE transport endpoints ---------------- */
const sseTransports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;

  res.on("close", () => {
    delete sseTransports[transport.sessionId];
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports[sessionId];
  if (!transport) {
    res.status(400).send("No transport found for sessionId");
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

/* ---------------- Health check ---------------- */
app.get("/", (_, res) => res.json({ ok: true }));

/* ---------------- Start ---------------- */
const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log(`MCP listening on :${port}`);
});
