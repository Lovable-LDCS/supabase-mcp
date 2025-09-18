import * as m from "@modelcontextprotocol/sdk";
console.log("DEFAULT KEYS:", Object.keys(m));
try {
  const s = await import("@modelcontextprotocol/sdk/server");
  console.log("SERVER KEYS:", Object.keys(s));
} catch(e) { console.log("no /server export:", String(e).slice(0,200)); }
try {
  const t = await import("@modelcontextprotocol/sdk/transport/sse");
  console.log("TRANSPORT/SSE KEYS:", Object.keys(t));
} catch(e) { console.log("no /transport/sse export:", String(e).slice(0,200)); }
try {
  const t2 = await import("@modelcontextprotocol/sdk/server/transport/sse");
  console.log("SERVER/TRANSPORT/SSE KEYS:", Object.keys(t2));
} catch(e) { console.log("no /server/transport/sse export:", String(e).slice(0,200)); }
