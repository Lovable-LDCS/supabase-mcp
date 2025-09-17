// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();

/* ------------ CORS & basics ------------ */
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
      // Important for ChatGPT’s MCP client
      "OpenAI-Beta",
    ],
    exposedHeaders: ["Content-Type"],
  })
);

// JSON parsing
app.use(express.json({ limit: "5mb" }));

// ✅ Preflight handler WITHOUT any path (bypasses path-to-regexp entirely)
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ------------ Supabase ------------ */
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || "",
  { auth: { persistSession: false } }
);

/* ------------ MCP server & tools ------------ */
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
      content: [{ type: "text", text: JSON.stringify({ rows: data }, null, 2) }],
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
      content: [{ type: "text", text: JSON.stringify({ rows: data }, null, 2) }],
    };
  }
);

/* ------------ Legacy SSE transport endpoints ------------ */
const sseTransports = /** @type {Record<string, SSEServerTransport>} */ ({});

// 1) Open SSE
app.get("/sse", async (_req, res) => {
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

// 2) Post messages (force 200 OK if SDK leaves 202)
app.post("/messages", express.json({ limit: "5mb" }), async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  const transport = sseTransports[sessionId];
  if (!sessionId || !transport) {
    console.warn(`[MSG] no transport for sessionId=${sessionId}`);
    return res.status(400).send("No transport found for sessionId");
  }

  // Track whether SDK wrote the response
  let finished = false;
  res.on("finish", () => (finished = true));

  try {
    console.log(`[MSG] in   sessionId=${sessionId}`);
    await transport.handlePostMessage(req, res, req.body);

    // If SDK didn't send anything or left 202, normalize to 200
    if (!finished) {
      res.status(200).end();
      finished = true;
    } else if (res.statusCode === 202) {
      // Can't change status after finish, but we can log it for visibility
      console.warn(`[MSG] status=202 (client may expect 200)`);
    }

    console.log(`[MSG] out  sessionId=${sessionId} status=${res.statusCode}`);
  } catch (e) {
    console.error("[MSG] error", e);
    if (!res.headersSent) res.status(500).send("Internal error");
  }
});

/* ------------ Health & Version ------------ */
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    git: {
      branch: process.env.RENDER_GIT_BRANCH || null,
      commit: process.env.RENDER_GIT_COMMIT || null,
      deployId: process.env.RENDER_DEPLOY_ID || null,
    },
  });
});

/* ------------ Start ------------ */
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log(`MCP listening on :${port}`);
  console.log(
    `[deploy] branch=${process.env.RENDER_GIT_BRANCH || "?"} commit=${(process.env.RENDER_GIT_COMMIT || "?").slice(0,7)}`
  );
});
