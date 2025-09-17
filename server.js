// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();
app.disable("x-powered-by");

/* ------------ CORS & basics ------------ */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    // Mirror any requested headers so nothing gets blocked
    allowedHeaders: (req, cb) => {
      const reqHdrs = req.header("Access-Control-Request-Headers");
      cb(
        null,
        reqHdrs
          ? reqHdrs
          : "Content-Type, Authorization, Accept, Cache-Control, Last-Event-ID, OpenAI-Beta, OpenAI-Organization, OpenAI-Project"
      );
    },
    exposedHeaders: ["Content-Type"],
  })
);

// JSON parsing
app.use(express.json({ limit: "5mb" }));

// Global preflight (no path → avoids path-to-regexp entirely)
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
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

/* ------------ SSE transport endpoints ------------ */
const sseTransports = /** @type {Record<string, SSEServerTransport>} */ ({});

// 1) Open SSE
app.get("/sse", async (_req, res) => {
  try {
    // Be explicit for picky proxies
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");

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

// 2) Post messages — only send fallback if nothing was sent
app.post("/messages", express.json({ limit: "5mb" }), async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  const transport = sseTransports[sessionId];
  if (!sessionId || !transport) {
    console.warn(`[MSG] no transport for sessionId=${sessionId}`);
    return res.status(400).json({ error: "No transport found for sessionId" });
  }

  // Light diagnostics
  const hdr = (n) => req.headers[n.toLowerCase()];
  const bodyStr = JSON.stringify(req.body ?? null);
  console.log(
    `[MSG] hdrs sessionId=${sessionId} ct=${hdr("content-type") || "-"} beta=${hdr("openai-beta") || "-"} origin=${hdr("origin") || "-"} bytes=${Buffer.byteLength(bodyStr || "")}`
  );

  try {
    // Let the SDK handle the message. It may send/finish the response.
    await transport.handlePostMessage(req, res, req.body);

    // After the SDK returns, only write if nothing has been sent yet.
    if (!res.headersSent && !res.writableEnded) {
      res.status(200).json({ ok: true });
    }

    console.log(
      `[MSG] out  sessionId=${sessionId} status=${res.statusCode} sent=${res.headersSent} ended=${res.writableEnded}`
    );
  } catch (e) {
    console.error("[MSG] error", e);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
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



