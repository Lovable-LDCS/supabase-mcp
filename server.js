// server.js  (patch v4: force 200 and ensure non-empty JSON body on /messages)
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

app.use(express.json({ limit: "5mb" }));

// Global preflight (no path string → avoids path-to-regexp)
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

// 2) Post messages — force 200 and ensure a tiny JSON body
app.post("/messages", express.json({ limit: "5mb" }), async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  const transport = sseTransports[sessionId];
  if (!sessionId || !transport) {
    console.warn(`[MSG] no transport for sessionId=${sessionId}`);
    return res.status(400).json({ error: "No transport found for sessionId" });
  }

  // --- Interceptors: normalize headers + body --------------------------------
  const origWriteHead = res.writeHead;
  const origWrite = res.write;
  const origEnd = res.end;

  let patchedFired = false;
  let bytesWritten = 0;

  // Normalize 202 → 200
  res.writeHead = function patchedWriteHead(statusCode, ...rest) {
    if (statusCode === 202) {
      patchedFired = true;
      console.log("[MSG] writeHead patch: 202 → 200");
      statusCode = 200;
    }
    return origWriteHead.call(this, statusCode, ...rest);
  };

  // Track body size
  res.write = function patchedWrite(chunk, ...rest) {
    if (chunk) bytesWritten += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    return origWrite.call(this, chunk, ...rest);
  };

  // If SDK ends without a body, inject a tiny JSON body
  res.end = function patchedEnd(chunk, ...rest) {
    let localChunk = chunk;
    if (!localChunk && bytesWritten === 0) {
      const payload = JSON.stringify({ ok: true });
      if (!res.getHeader("Content-Type")) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      localChunk = Buffer.from(payload, "utf8");
      bytesWritten = localChunk.length;
      if (res.statusCode === 202) {
        console.log("[MSG] end patch: status 202 → 200");
        res.statusCode = 200;
      }
      console.log("[MSG] end patch: injected {ok:true}");
    }
    return origEnd.call(this, localChunk, ...rest);
  };
  // ---------------------------------------------------------------------------

  // Light diagnostics
  const hdr = (n) => req.headers[n.toLowerCase()];
  const bodyStr = JSON.stringify(req.body ?? null);
  console.log(
    `[MSG] hdrs sessionId=${sessionId} ct=${hdr("content-type") || "-"} beta=${hdr("openai-beta") || "-"} origin=${hdr("origin") || "-"} bytes=${Buffer.byteLength(bodyStr || "")}`
  );

  try {
    await transport.handlePostMessage(req, res, req.body);

    // If somehow nothing got sent, finish with 200 + tiny body (belt & suspenders)
    if (!res.headersSent && !res.writableEnded) {
      console.log("[MSG] fallback body → 200 {ok:true}");
      res.status(200).json({ ok: true });
    }

    console.log(
      `[MSG] out  sessionId=${sessionId} status=${res.statusCode} sent=${res.headersSent} ended=${res.writableEnded} patchFired=${patchedFired} bodyBytes=${bytesWritten}`
    );
  } catch (e) {
    console.error("[MSG] error", e);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  } finally {
    // Restore (per-request)
    res.writeHead = origWriteHead;
    res.write = origWrite;
    res.end = origEnd;
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
      patch: "v4",
    },
  });
});

/* ------------ Start ------------ */
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log(`MCP listening on :${port}  (patch v4)`);
  console.log(
    `[deploy] branch=${process.env.RENDER_GIT_BRANCH || "?"} commit=${(process.env.RENDER_GIT_COMMIT || "?").slice(0,7)}`
  );
});



