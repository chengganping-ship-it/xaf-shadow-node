/**
 * Stage X1 本地冒烟 —— 不装 wrangler、不联网、不起服务。
 * 直接在 Node 里调用 Worker 的 fetch()，用它做「会产生uerit证据的边界」验证。
 *
 * 运行： node test/smoke.mjs [--verbose]
 */

import worker from "../src/index.js";
import { assertTestnet } from "../src/safety.js";

const VERBOSE = process.argv.includes("--verbose");

let pass = 0;
let fail = 0;
const rows = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    rows.push({ status: "✅", name, detail });
  } else {
    fail += 1;
    rows.push({ status: "❌", name, detail });
  }
  return cond;
}

function baseEnv(overrides = {}) {
  return {
    XAF_NODE_ID: "ghost-node-00",
    XAF_TOOLSET_VERSION: "x1.0",
    XAF_MCP_PROTOCOL_VERSION: "2025-06-18",
    X402_MODE: "free",
    X402_NETWORK: "base-sepolia",
    X402_FACILITATOR_URL: "",
    // ✅ 已上链校验：Base Sepolia USDC (symbol=USDC, decimals=6)
    XAF_TESTNET_USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    XAF_TESTNET_PAYTO: "0x0000000000000000000000000000000000000000",
    XAF_FREE_QUOTA_JSON: '{"rights_precheck":3,"c2c_lead_sniff":5,"portfolio_valuation":2}',
    XAF_CORS_ORIGINS: "*",
    XAF_LOG_LEVEL: "info",
    ...overrides,
  };
}

async function call(env, { path = "/mcp", method = "POST", body, raw, headers = {} }) {
  const req = new Request(`https://xaf-shadow-node.workers.dev${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json", ...headers } : headers,
    // raw= 用于发送"故意非法"的 JSON，验证 -32700 解析错误路径
    body: method === "POST" ? (raw !== undefined ? raw : JSON.stringify(body)) : undefined,
  });
  return worker.fetch(req, env, {});
}

async function rpc(env, payload, headers = {}) {
  const res = await call(env, { body: payload, headers });
  return { res, json: await res.json().catch(() => null) };
}

console.log("\n=== XAF Phase X / Stage X1 — Shadow Node Smoke ===\n");

// ── 1. 基础设施 ────────────────────────────────────────────────────────────
{
  const env = baseEnv();
  const health = await call(env, { path: "/health", method: "GET" });
  const body = await health.json();
  check("GET /health 200", health.status === 200, `status=${health.status}`);
  check("health 网络=base-sepolia", body.network === "base-sepolia" && body.chain_id === 84532, JSON.stringify(body));

  const ready = await call(env, { path: "/ready", method: "GET" });
  check("GET /ready 200 + redlines ok", ready.status === 200 && (await ready.json()).redlines === true);

  const cors = await call(env, { path: "/mcp", method: "OPTIONS" });
  check("OPTIONS 预检 204 + CORS", cors.status === 204, `status=${cors.status}`);

  const sse = await call(env, { path: "/sse", method: "GET" });
  check("GET /sse 明确 405（无状态 HTTP-only）", sse.status === 405);

  const root = await call(env, { path: "/", method: "GET" });
  check("GET / 200 + 端点提示", root.status === 200 && (await root.json()).endpoint_hint.includes("/mcp"));
}

// ── 2. MCP 握手 ────────────────────────────────────────────────────────────
{
  const env = baseEnv();
  const { res, json } = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  check("initialize 返回 protocolVersion", res.status === 200 && json.result.protocolVersion === "2025-06-18");
  check("initialize 声明 sessionless", json.result.capabilities?.sessionless === true);

  const list = await rpc(env, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const names = (list.json.result.tools ?? []).map((t) => t.name);
  check("tools/list 暴露 3 个 Tool", names.length === 3, names.join(","));
  check("Tool 名与规范一致", ["rights_precheck", "c2c_lead_sniff", "portfolio_valuation"].every((n) => names.includes(n)), names.join(","));
  check("每个 Tool 都带 inputSchema", (list.json.result.tools ?? []).every((t) => t.inputSchema?.type === "object"));
}

// ── 3. rights_precheck ─────────────────────────────────────────────────────
{
  const env = baseEnv();
  const phone = "13812345678";
  const { res, json } = await rpc(env, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "rights_precheck",
      arguments: { content: `你好，我的原创插画被侵权了，想做数据确权并且知道怎么登记？联系我 ${phone} 或 yao@xaf.dev`, asset_type: "image" },
    },
  });
  const r = json.result?.structuredContent;
  check("rights_precheck 200", res.status === 200 && !!r, `status=${res.status}`);
  check("意向分级 HOT", r?.priority === "HOT", `priority=${r?.priority} score=${r?.intent_score}`);
  check("资产类别 image", r?.asset_class === "image", String(r?.asset_class));
  check("返回推荐通道", Array.isArray(r?.channels) && r.channels.length > 0, `${r?.channels?.length} 条`);
  check("PII 已脱敏", r?.compliance?.pii_masked === true, JSON.stringify(r?.compliance?.violations));
  check("回显文本不含手机号", !r?.sanitized_excerpt?.includes(phone), r?.sanitized_excerpt?.slice(0, 80));
  check("回显文本不含原始邮箱", !r?.sanitized_excerpt?.includes("yao@xaf.dev"));
  check("推荐 SKU 有价格锚点", typeof r?.recommended_service?.price_cny === "number", JSON.stringify(r?.recommended_service));

  if (VERBOSE) console.log(JSON.stringify(r, null, 2).slice(0, 1200));
}

// ── 4. 违规承诺词熔断 ──────────────────────────────────────────────────────
{
  const env = baseEnv();
  const { json } = await rpc(env, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "rights_precheck", arguments: { content: "我们有官方内部渠道，保证通过审核，100%拿证，做数据确权" } },
  });
  const r = json.result?.structuredContent;
  check("违规承诺被标记 passed=false", r?.compliance?.passed === false, JSON.stringify(r?.compliance?.violations));
  check("承诺词已净化", r?.sanitized_excerpt?.includes("[已删除-违规承诺]"), r?.sanitized_excerpt);
}

// ── 5. c2c_lead_sniff ──────────────────────────────────────────────────────
{
  const env = baseEnv();
  const { json } = await rpc(env, {
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      name: "c2c_lead_sniff",
      arguments: {
        messages: [
          "在闲鱼问：我的小说被抄袭了，能不能做版权登记？需要多少钱",
          "想把我的数据集授权给AI训练，怎么变现？",
          "兼职日结300，加微信详聊",
          "这条就是随便聊聊，没有意图",
        ],
        threshold: 0.3,
      },
    },
  });
  const r = json.result?.structuredContent;
  check("scan 4 条", r?.scanned === 4, String(r?.scanned));
  check("识别平台 xianyu", r?.top_leads?.some((l) => l.platforms?.includes("xianyu")), JSON.stringify(r?.top_leads?.map((l) => l.platforms)));
  check("负向排除过滤掉噪音", r?.summary?.NOISE >= 1, JSON.stringify(r?.summary));
  check("高意向线索进入 TOP", r?.top_leads?.[0]?.score >= 0.3, JSON.stringify(r?.top_leads?.[0]?.score));
  check("给出管线金额估算", typeof r?.estimated_pipeline_cny === "number", String(r?.estimated_pipeline_cny));

  if (VERBOSE) console.log(JSON.stringify(r?.top_leads, null, 2).slice(0, 900));
}

// ── 6. portfolio_valuation ─────────────────────────────────────────────────
{
  const env = baseEnv();
  const { json } = await rpc(env, {
    jsonrpc: "2.0",
    id: 30,
    method: "tools/call",
    params: {
      name: "portfolio_valuation",
      arguments: {
        assets: [
          { name: "C2C互动日志", type: "interaction_logs", volume_units: 150, quality: 0.7, license_model: "per_unit", anonymized: true },
          { name: "话术模板库", type: "templates", volume_units: 15, quality: 0.8, license_model: "subscription", anonymized: true },
          { name: "合规知识库", type: "compliance_kb", volume_units: 3, quality: 0.6, license_model: "subscription", anonymized: false },
        ],
        horizon_years: 1,
      },
    },
  });
  const r = json.result?.structuredContent;
  check("三笔资产估值", r?.rows?.length === 3, String(r?.rows?.length));
  check("组合期望值 > 0", (r?.portfolio?.value_cny_expected ?? 0) > 0, String(r?.portfolio?.value_cny_expected));
  check("上下界单调 low<=high", r?.rows?.every((x) => x.value_cny_low <= x.value_cny_high), "");
  check("未脱敏资产被扣合规成本", r?.rows?.[2]?.prep_cost_cny > 0, String(r?.rows?.[2]?.prep_cost_cny));
  check("输出 testnet USDC 最小单位", /^\d+$/.test(String(r?.portfolio?.value_usdc_atomic_testnet)), String(r?.portfolio?.value_usdc_atomic_testnet));
  check("给出变现排序", r?.recommended_monetization_order?.length === 3);
}

// ── 7. 错误信封 ────────────────────────────────────────────────────────────
{
  const env = baseEnv();
  const missing = await rpc(env, { jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "rights_precheck", arguments: {} } });
  check("缺参 → -32602", missing.json.error?.code === -32602, JSON.stringify(missing.json.error));
  check("缺参 → HTTP 422", missing.res.status === 422, String(missing.res.status));

  const badEnum = await rpc(env, { jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "rights_precheck", arguments: { content: "x", asset_type: "火星资产" } } });
  check("enum 越界 → -32602", badEnum.json.error?.code === -32602);

  const unknown = await rpc(env, { jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "nuke_mainnet", arguments: {} } });
  check("未知 Tool → -32602（标准无效参数）", unknown.json.error?.code === -32602, JSON.stringify(unknown.json.error));

  const noMethod = await rpc(env, { jsonrpc: "2.0", id: 43, method: "foo/bar", params: {} });
  check("未知方法 → -32601", noMethod.json.error?.code === -32601);

  const extra = await rpc(env, { jsonrpc: "2.0", id: 44, method: "tools/call", params: { name: "rights_precheck", arguments: { content: "x", evil: 1 } } });
  check("additionalProperties 拒绝", extra.json.error?.code === -32602);

  const malformed = await call(env, { path: "/mcp", method: "POST", raw: "{not json" });
  const mj = await malformed.json();
  check("非法 JSON → -32700", mj.error?.code === -32700, JSON.stringify(mj.error));
  check("非法 JSON → HTTP 400", malformed.status === 400);
}

// ── 8. 红线 A：主网熔断 ────────────────────────────────────────────────────
{
  let thrown = false;
  try {
    assertTestnet(8453, "test-vector");
  } catch {
    thrown = true;
  }
  check("assertTestnet(8453) 抛错", thrown);

  const env = baseEnv({ X402_NETWORK: "base" });
  const res = await call(env, { path: "/health", method: "GET" });
  const body = await res.json();
  check("主网 network 配置 → 全站 503 密封", res.status === 503, `status=${res.status} ${JSON.stringify(body).slice(0, 120)}`);
}

// ── 9. 红线 B：法币网关熔断 ────────────────────────────────────────────────
{
  const env = baseEnv({ X402_FACILITATOR_URL: "https://api.stripe.com/v1/charges" });
  const res = await call(env, { path: "/manifest", method: "GET" });
  check("Stripe 引用 → 503 密封", res.status === 503, String(res.status));
}

// ── 10. x402 门禁：strict 模式产出标准 402 ─────────────────────────────────
{
  const env = baseEnv({ X402_MODE: "strict" });
  const res = await call(env, {
    path: "/mcp",
    method: "POST",
    body: { jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "portfolio_valuation", arguments: { assets: [{ name: "a", type: "templates" }] } } },
    headers: {},
  });
  const body = await res.json();
  check("strict 无凭证 → HTTP 402", res.status === 402, String(res.status));
  check("402 header x-payment-required", res.headers.get("x-payment-required") === "true");
  check("accepts.network = base-sepolia", body.accepts?.[0]?.network === "base-sepolia", JSON.stringify(body.accepts?.[0]).slice(0, 160));
  check("accepts.chainId = 84532", body.accepts?.[0]?.chainId === 84532);
  check("maxAmountRequired 为 USDC 最小单位", body.accepts?.[0]?.maxAmountRequired === "200000", String(body.accepts?.[0]?.maxAmountRequired));
  check("无 X-PAYMENT → no_payment_header", body.verification?.reason === "no_payment_header", JSON.stringify(body.verification));

  // 结构完整、网络合法、payTo 匹配的测试网凭证 → X1 仍未接 facilitator，必须明确拒绝而非放行
  const goodProof = Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: "0x" + "11".repeat(65),
        authorization: {
          from: "0x1111111111111111111111111111111111111111",
          to: "0x0000000000000000000000000000000000000000",
          value: "100000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0x" + "22".repeat(32),
        },
      },
    }),
  ).toString("base64");

  const gated = await call(env, {
    path: "/mcp",
    method: "POST",
    body: { jsonrpc: "2.0", id: 52, method: "tools/call", params: { name: "rights_precheck", arguments: { content: "数据确权" } } },
    headers: { "x-payment": goodProof },
  });
  const gatedBody = await gated.json();
  check("合法测试网凭证 X1 仍不认账（不伪放行）", gated.status === 402, String(gated.status));
  check("拒因 = facilitator_not_configured", gatedBody.verification?.reason === "facilitator_not_configured", JSON.stringify(gatedBody.verification));

  const withProof = await call(env, {
    path: "/mcp",
    method: "POST",
    body: { jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "rights_precheck", arguments: { content: "数据确权" } } },
    headers: { "x-payment": Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "ethereum-mainnet", payload: {} })).toString("base64") },
  });
  const body2 = await withProof.json();
  check("主网凭证被拒（不放行）", withProof.status === 402, String(withProof.status));
  check("主网凭证原因 network_not_allowed", body2.verification?.detail?.data?.redline === "A-mainnet-fuse", JSON.stringify(body2.verification));
}

// ── 11. 零真实身份：响应头不回显来源 ───────────────────────────────────────
{
  const env = baseEnv();
  const res = await call(env, { path: "/manifest", method: "GET" });
  const txt = await res.text();
  check("安全头 no-referrer", res.headers.get("referrer-policy") === "no-referrer");
  check("manifest 声明 no_real_identity", JSON.parse(txt).safety?.no_real_identity === true);
  check("manifest 声明 testnet_only", JSON.parse(txt).payment?.testnet_only === true);
}

console.log("\n── 明细 ─────────────────────────────────────────────────────────────");
for (const r of rows) console.log(`${r.status} ${r.name}${r.detail ? `  ·  ${String(r.detail).slice(0, 120)}` : ""}`);
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(`PASS ${pass} / FAIL ${fail} / TOTAL ${rows.length}`);
console.log(fail === 0 ? "✅ Stage X1 本地冒烟全通过\n" : "❌ 存在失败用例，修完再谈部署\n");
process.exit(fail === 0 ? 0 : 1);
