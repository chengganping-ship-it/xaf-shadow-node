/**
 * XAF Shadow Node — Cloudflare Workers 入口
 * ============================================================================
 * Stage X1 边缘网关：Stateless MCP over HTTPS + x402 测试网支付门禁。
 *
 * 三条设计规范：
 *   1. 控制器只做 HTTP 语义，业务逻辑全在 src/core/*；服务端完全无状态。
 *   2. 全程零持久层：不写 KV/D1，不记录 IP/UA/指纹 ⇒ 没有可被溯源的身份数据。
 *   3. 红线在启动期熔断：guardTopLevelEnv 不通过 ⇒ 全站 503，绝不降级放行。
 */

import { AppError } from "./errors.js";
import { guardTopLevelEnv, resolveNetwork, TESTNET_CHAINS } from "./safety.js";
import { handleRpc, parseRpcPayload, rpcFail } from "./jsonrpc.js";
import { guardToolCall, quotaSnapshot, requirementsFor } from "./x402.js";
import { TOOL_PRICING_USD, pricingTable } from "./pricing.js";
import { listTools, TOOL_MAP } from "./catalog.js";
import { record, snapshot } from "./telemetry.js";

const MAX_BODY_BYTES = 256 * 1024;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function corsHeaders(request, env) {
  const allow = env?.XAF_CORS_ORIGINS || "*";
  const origin = request.headers.get("origin");
  const value = allow === "*" ? "*" : String(allow).split(",").map((s) => s.trim()).filter((s) => s === origin).join("") || "null";
  return {
    "access-control-allow-origin": value,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-payment, mcp-protocol-version",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

// 日志阈值。旧实现的判断写成 `(level === "debug") || level !== "debug"`，恒为 true ⇒
// 把 XAF_LOG_LEVEL 设成 error 照样打印 info/warn，等于阈值开关坏了还没人发现。
const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

function log(level, env, requestId, event, fields = {}) {
  const configured = String(env?.XAF_LOG_LEVEL || "info").toLowerCase();
  const threshold = LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
  if ((LEVEL_ORDER[level] ?? LEVEL_ORDER.info) < threshold) return;
  // ⛔ 刻意不记录 CF-Connecting-IP / User-Agent / Cookie —— 零真实身份红线。
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, requestId, node: env?.XAF_NODE_ID ?? "ghost-node-00", event, ...fields }));
}

function priceOf(name) {
  const p = TOOL_PRICING_USD[name];
  return p === undefined ? Number.NEGATIVE_INFINITY : p;
}

/** 只按"已知且已定价"的 tool 收过路费；未知 tool 交给 RPC 层回 -32601，不在门禁里炸。 */
function pickGatedTool(reqs) {
  const names = reqs
    .filter((r) => r && r.method === "tools/call" && typeof r.params?.name === "string")
    .map((r) => r.params.name)
    .filter((n) => TOOL_MAP[n] !== undefined && priceOf(n) !== Number.NEGATIVE_INFINITY);
  if (!names.length) return null;
  return names.reduce((best, n) => (priceOf(n) > priceOf(best) ? n : best), names[0]);
}

async function handlePost(request, url, env, ctx, requestId) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json(rpcFail(null, new AppError("INVALID_REQUEST", "请求体超过 256KB 上限", {})), 413, corsHeaders(request, env));
  }

  const parsed = parseRpcPayload(raw);
  if (!Array.isArray(parsed)) {
    return json(rpcFail(null, new AppError("PARSE_ERROR", `JSON 解析失败: ${parsed.parseError}`, {})), 400, corsHeaders(request, env));
  }

  const isBatch = parsed.length > 1;
  const gatedTool = pickGatedTool(parsed);
  let settleFn = null;
  let gateReceipt = null;

  if (gatedTool) {
    const verdict = guardToolCall({ request, url, tool: gatedTool, env });
    // strict + 已配置 facilitator 时门禁是异步的（要验签），其余分支同步返回
    const v = verdict.promise ? await verdict.promise : verdict;
    if (!v.allowed) {
      record(env, "x402_issued", { tool: gatedTool });
      log("info", env, requestId, "x402_402_issued", { tool: gatedTool, mode: env?.X402_MODE ?? "free" });
      return new Response(v.response.body, {
        status: 402,
        headers: { ...Object.fromEntries(v.response.headers), ...corsHeaders(request, env) },
      });
    }
    gateReceipt = v.receipt;
    settleFn = v.settle;
  }

  const rpcCtx = {
    protocolVersion: env?.XAF_MCP_PROTOCOL_VERSION || "2025-06-18",
    toolsetVersion: env?.XAF_TOOLSET_VERSION || "x1.0",
  };

  const results = [];
  let httpStatus = 200;
  for (const req of parsed) {
    if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      results.push(rpcFail(req?.id ?? null, new AppError("INVALID_REQUEST", "不符合 JSON-RPC 2.0 结构", {})));
      httpStatus = 400;
      continue;
    }
    const rpcMethod = typeof req?.method === "string" ? req.method : "unknown";
    record(env, "rpc_handled", { method: rpcMethod });
    try {
      const out = handleRpc(req, rpcCtx);
      if (out.body) results.push(out.body);
      // Tool 成败按 JSON-RPC 的 result/error 判定，而不是按自己的心情：
      // 有 result ⇒ tool_ok；有 error ⇒ tool_fail。二者必居其一，故用 else 而非再判断。
      if (rpcMethod === "tools/call") {
        const tool = typeof req.params?.name === "string" ? req.params.name : "";
        record(env, out.body && out.body.result ? "tool_ok" : "tool_fail", { tool });
      }
      httpStatus = Math.max(httpStatus, out.status === 202 ? 200 : out.status === 404 ? 404 : out.status === 402 ? 402 : out.status);
    } catch (e) {
      log("error", env, requestId, "rpc_dispatch_failed", { error: e instanceof Error ? e.message : String(e) });
      results.push(rpcFail(req.id ?? null, e));
      httpStatus = Math.max(httpStatus, e instanceof AppError ? e.httpStatus : 500);
    }
  }

  log("debug", env, requestId, "rpc_handled", { methods: parsed.map((r) => r?.method), gatedTool, status: httpStatus });

  if (!results.length) return new Response(null, { status: 202, headers: corsHeaders(request, env) });

  // 三段式最后一段：deliver。工具执行成功 ⇒ settle；工具失败 ⇒ 不结算（避免"付了钱没拿到数据"）
  if (settleFn) {
    const ok3 = httpStatus === 200;
    if (ok3) {
      const settlement = await settleFn();
      gateReceipt = { ...(gateReceipt ?? {}), settlement };
      if (settlement.settled) record(env, "x402_settled", { tool: gatedTool });
      log("info", env, requestId, settlement.settled ? "x402_settled" : "x402_settle_skipped", {
        tool: gatedTool,
        txHash: settlement.txHash ?? null,
        reason: settlement.reason ?? null,
      });

      // ⛔ 真结算模式下 settle 失败 ⇒ **不交付数据**，重发 402 让调用方重试。
      //    mock/free/simulation 的 simulated:true 不算失败（本来就没打算收钱），不能误伤。
      //    这条在 mock 时代永远不会被触发，一旦接真链就变成"白送数据"，所以提前钉死。
      if (settlement.settled === false && settlement.simulated !== true) {
        log("warn", env, requestId, "x402_settle_failed_delivery_blocked", {
          tool: gatedTool,
          reason: settlement.reason ?? null,
        });
        return json(
          {
            error: "Payment settlement failed (x402) — 数据未交付，付款未成立",
            x402Version: 1,
            ...requirementsFor(gatedTool, url, env),
            settlement,
          },
          402,
          {
            ...corsHeaders(request, env),
            // 回执照给：调用方要看得见"为什么没结算成功"，否则只能盲目重试
            "x-payment-response": b64(JSON.stringify(gateReceipt ?? { settlement })),
          },
        );
      }
    } else {
      log("warn", env, requestId, "x402_settle_aborted_tool_failed", { tool: gatedTool, httpStatus });
    }
  }

  const headers = { ...corsHeaders(request, env) };
  if (gateReceipt) headers["x-payment-response"] = b64(JSON.stringify(gateReceipt));

  return json(isBatch ? results : results[0], httpStatus === 202 ? 200 : httpStatus, headers);
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function manifest(env) {
  const net = resolveNetwork(env?.X402_NETWORK);
  return {
    name: "XAF Shadow Node",
    node_id: env?.XAF_NODE_ID ?? "ghost-node-00",
    toolset_version: env?.XAF_TOOLSET_VERSION ?? "x1.0",
    transport: { type: "stateless-http", endpoint: "/mcp", methods: ["POST"], jsonrpc: "2.0", session_required: false },
    tools: listTools().map((t) => ({ name: t.name, title: t.title, description: t.description, price_usd: TOOL_PRICING_USD[t.name] })),
    payment: {
      protocol: "x402",
      version: 1,
      mode: env?.X402_MODE ?? "free",
      network: net.network,
      chain_id: net.chainId,
      asset: env?.XAF_TESTNET_USDC,
      pay_to: env?.XAF_TESTNET_PAYTO,
      testnet_only: true,
      mainnet_fuse: "armed",
      fiat_gateways: "none",
    },
    safety: {
      allowed_chain_ids: Object.keys(TESTNET_CHAINS).map(Number),
      no_mainnet: true,
      no_fiat_gateway: true,
      no_real_identity: true,
      no_persistent_state: true,
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    // 启动期红线熔断（fail closed）
    const violations = guardTopLevelEnv(env);
    if (violations.length) {
      log("error", env, requestId, "redline_fuse_open", { violations });
      const allowHealth = url.pathname === "/health";
      const body = {
        error: "Safety redline violated — node sealed.",
        violations,
        note: allowHealth ? "节点已密封：修好 wrangler vars 才会恢复。" : undefined,
      };
      return json(body, 503, corsHeaders(request, env));
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      switch (true) {
        case request.method === "GET" && url.pathname === "/health": {
          const net = resolveNetwork(env?.X402_NETWORK);
          return json({ status: "ok", node: env?.XAF_NODE_ID ?? "ghost-node-00", network: net.network, chain_id: net.chainId, x402_mode: env?.X402_MODE ?? "free" }, 200, corsHeaders(request, env));
        }
        case request.method === "GET" && url.pathname === "/ready":
          return json({ ready: true, redlines: guardTopLevelEnv(env).length === 0, metering: quotaSnapshot(env) }, 200, corsHeaders(request, env));

        case request.method === "GET" && (url.pathname === "/manifest" || url.pathname === "/.well-known/mcp.json"):
          return json(manifest(env), 200, corsHeaders(request, env));

        case request.method === "GET" && url.pathname === "/metrics":
          // 匿名计数快照。刻意公开：X4 的 RSI 需要一个真反馈源。
          // 公开的是"有多少次调用"，不是"谁调用了" —— 后者这份实现里根本不存在。
          return json(snapshot(env), 200, { ...corsHeaders(request, env), "cache-control": "no-store" });

        case request.method === "GET" && url.pathname === "/pricing":
          return json({ pricing: pricingTable(), free_quota: quotaSnapshot(env) }, 200, corsHeaders(request, env));

        case request.method === "GET" && (url.pathname === "/" || url.pathname === "/mcp" || url.pathname === "/rpc"):
          return json({ node: "XAF Shadow Node", endpoint_hint: "POST /mcp (JSON-RPC 2.0, stateless)", tools: Object.keys(TOOL_PRICING_USD) }, 200, corsHeaders(request, env));

        case request.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/rpc" || url.pathname === "/"):
          return handlePost(request, url, env, ctx, requestId);

        case url.pathname === "/sse":
          return json({ error: "SSE transport disabled: this node is stateless HTTP-only.", tip: "POST JSON-RPC to /mcp" }, 405, corsHeaders(request, env));

        default:
          return json({ error: "not_found", path: url.pathname }, 404, corsHeaders(request, env));
      }
    } catch (e) {
      log("error", env, requestId, "unhandled", { error: e instanceof Error ? e.message : String(e) });
      // ⛔ 只回传规范化错误，绝不带堆栈
      return json(rpcFail(null, new AppError("INTERNAL_ERROR", "节点内部错误", { requestId })), 500, corsHeaders(request, env));
    }
  },
};
