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
/**
 * Some MCP clients add headers like OpenAI-Beta, OpenAI-Organization, etc.
 * Mirror back whatever the browser requests on preflight so nothing gets blocked.
 */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: (req, cb) => {
      const reqHdrs = req.header("Access-Control-Request-Headers");
      cb(null, reqHdrs ? reqHdrs : "Content-Type, Authorization, Accept, Cache-Control, Last-Event-ID, OpenAI-Beta, OpenAI-Organization, OpenAI-Project");
    },
    exposedHeaders: ["Content-Type"],
  })
);

// JSON parsing
app.use(express.json({ limit: "5mb" }));

// ✅ Global preflight handler (no path string → bypass path-to-regexp)
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    // echo requested headers so the browser proceeds
    const reqHdrs = req.header("Access-Control-Request-Headers");
    if (reqHdrs) res.setHeader("Access-Control-Allow-Headers", reqHdrs);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.sendStatus(204);
  }
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

// 2) Post messages — normalize to 200 OK, add debug logs for headers/body
app.post("/messages", express.json({ limit: "5mb" }), async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  const transport = sseTransports[sessionId];
  if (!sessionId || !transport) {
    console.warn(`[MSG] no transport for sessionId=${sessionId}`);
    return res.status(400).send("No transport found for sessionId");
  }

  // Debug: log a few important headers (trim noisy ones)
  const hdr = (name) => req.headers[name.toLowerCase()];
  console.log(
    `[MSG] hdrs sessionId=${sessionId} content-type=${hdr("content-type") || "-"} openai-beta=${hdr("openai-beta") || "-"} origin=${hdr("origin") || "-"}`
  );

  let finished = false;
  res.on("finish", () => (finished = true));

  try {
    console.log(`[MSG] in   sessionId=${sessionId} bytes=${Buffer.byteLength(JSON.stringify(req.body) || "")}`);
    await transport.handlePostMessage(req, res, req.body);

    if (!finished) {
      res.status(200).end();
      finished = true;
    } else if (res.statusCode === 202) {
      // If SDK set 202, change to 200 before flush (best-effort)
      try { res.statusCode = 200; } catch {}
      console.warn(`[MSG] status adjusted → 200`);
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


