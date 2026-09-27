/**
 * 本地 HTTP 适配器 —— 把 Worker 的 fetch() 挂到一个真实端口上，跑 curl 级冒烟。
 * 用途：在 wrangler 无法安装/无 CF 凭据时，仍能产出"真的起了服务"的证据。
 *
 * 运行： node test/serve.mjs [port]
 */

import { createServer } from "node:http";
import worker from "../src/index.js";

const port = Number(process.argv[2] ?? 8787);

const env = {
  XAF_NODE_ID: "ghost-node-00",
  XAF_TOOLSET_VERSION: "x1.0",
  XAF_MCP_PROTOCOL_VERSION: "2025-06-18",
  X402_MODE: process.env.X402_MODE ?? "free",
  X402_NETWORK: "base-sepolia",
  X402_FACILITATOR_URL: "",
  XAF_TESTNET_USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  XAF_CHAINS_VERIFIED: '{"84532":true,"80002":false}',
  X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL ?? "",
  X402_FACILITATOR_TIMEOUT_MS: "4000",
  XAF_TESTNET_PAYTO: "0x0000000000000000000000000000000000000000",
  XAF_FREE_QUOTA_JSON: '{"rights_precheck":3,"c2c_lead_sniff":5,"portfolio_valuation":2}',
  XAF_CORS_ORIGINS: "*",
  XAF_LOG_LEVEL: process.env.XAF_LOG_LEVEL ?? "info",
};

const server = createServer(async (nodeReq, nodeRes) => {
  const chunks = [];
  for await (const c of nodeReq) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");

  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (Array.isArray(v)) v.forEach((item) => headers.append(k, item));
    else if (v !== undefined) headers.set(k, v);
  }

  const request = new Request(`http://127.0.0.1:${port}${nodeReq.url}`, {
    method: nodeReq.method,
    headers,
    body: ["GET", "HEAD"].includes(nodeReq.method) ? undefined : body,
  });

  const res = await worker.fetch(request, env, {});
  nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
  nodeRes.end(res.body ? Buffer.from(await res.arrayBuffer()) : undefined);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[xaf-shadow-node] 本地冒烟端点: http://127.0.0.1:${port}/mcp  (mode=${env.X402_MODE})`);
});
