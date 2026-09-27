/**
 * Stage F4 — 影子经济体首周看板
 * =========================================================
 * 把 anonym 事件计数变成 X4（RSI 商业变异）能直接消费的反馈源。
 *
 * 数据来源两条，合并时**分别标注**，绝不混成"总数"让人误以为是同一个口径：
 *   ① local-isolate  本地 harness 跑出的模拟流量 → 体现"管道通不通"
 *   ② live-metrics   线上 Worker 的 /metrics     → 体现"真实世界有没有人打"
 *
 * ⛔ 本脚本不采集、不存储任何调用者身份信息。它读的字段在 src/telemetry.js 里
 *    已经被架构限制成「事件名 + tool 名 + method 名」三样标量。
 *
 * 用法：
 *   node test/x4_dashboard_run.mjs                # 只跑本地模拟流量
 *   node test/x4_dashboard_run.mjs --live https://xaf-shadow-node.<sub>.workers.dev
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { snapshot, __resetForTest } from "../src/telemetry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "shadow_dashboard.json");

const argv = process.argv.slice(2);
const liveIdx = argv.indexOf("--live");
const LIVE = liveIdx >= 0 ? argv[liveIdx + 1] : null;

const ENV = {
  XAF_NODE_ID: "ghost-node-00",
  XAF_TOOLSET_VERSION: "x1.0",
  XAF_MCP_PROTOCOL_VERSION: "2025-06-18",
  XAF_LOG_LEVEL: "error",
  // 看板要覆盖"有人被收费"的场景，所以跑 free + strict 两种模式各一遍
  X402_NETWORK: "base-sepolia",
  X402_FACILITATOR_URL: "",
  XAF_TESTNET_USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  XAF_TESTNET_PAYTO: "0x0000000000000000000000000000000000000000",
  XAF_CHAINS_VERIFIED: '{"84532":true,"80002":false}',
  XAF_FREE_QUOTA_JSON: '{"rights_precheck":3,"c2c_lead_sniff":5,"portfolio_valuation":2}',
  XAF_CORS_ORIGINS: "*",
  X402_MODE: "free",
};

function rp(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function post(env, body) {
  const res = await worker.fetch(
    new Request("https://xaf-shadow-node.local/mcp", { method: "POST", headers: { "content-type": "application/json" }, body }),
    env,
    {},
  );
  await res.text().catch(() => null);
  return res.status;
}

/** 模拟一周的典型访问构成：握手 → 列工具 → 三个 Tool 各来几次 → 夹带一个不存在的 Tool。 */
async function generateTraffic(env, label) {
  const hits = [];
  const push = (status) => hits.push(status);

  push(await post(env, rp(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dir-crawler", version: "0.1" } })));
  push(await post(env, rp(2, "tools/list", {})));
  push(await post(env, rp(3, "tools/call", { name: "rights_precheck", arguments: { content: "插画被电商平台盗用做成周边，想做版权登记，联系电话 13800138000" } })));
  push(await post(env, rp(4, "tools/call", { name: "rights_precheck", arguments: { content: "短视频背景音乐用了别人的曲子，会被判侵权吗" } })));
  push(await post(env, rp(5, "tools/call", { name: "c2c_lead_sniff", arguments: { messages: ["闲鱼有人问：我的插画被盗用了能做版权登记吗", "刷单兼职日结"], threshold: 0.3 } })));
  push(await post(env, rp(6, "tools/call", { name: "portfolio_valuation", arguments: { assets: [{ name: "插画作品集", type: "creative_work", volume_units: 12, quality: 0.7, anonymized: true }, { name: "客服对话语料", type: "interaction_logs", volume_units: 30000, license_model: "per_unit" }], horizon_years: 2 } })));
  push(await post(env, rp(7, "tools/call", { name: "does_not_exist", arguments: {} })));

  console.log(`  ${label}: ${hits.length} 次请求 → 状态码分布 ${JSON.stringify(hits.reduce((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {}))}`);
  return hits;
}

/** 劫持 console.log，验证 XAF_LOG_LEVEL 真的能压住低级别日志。 */
async function checkLogLevel() {
  const captured = [];
  const original = console.log;
  console.log = (...a) => captured.push(a.join(" "));
  try {
    await post({ ...ENV, XAF_LOG_LEVEL: "error" }, rp(99, "tools/call", { name: "rights_precheck", arguments: { content: "插画被盗用" } }));
    await post({ ...ENV, XAF_LOG_LEVEL: "error" }, rp(100, "tools/call", { name: "does_not_exist", arguments: {} }));
  } finally {
    console.log = original;
  }
  const parsed = captured.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const leak = parsed.filter((e) => e.level === "info" || e.level === "warn" || e.level === "debug");
  return {
    ok: leak.length === 0,
    detail: `XAF_LOG_LEVEL=error 下捕获 ${parsed.length} 条，其中 info/warn/debug 泄漏 ${leak.length} 条`,
    levels: [...new Set(parsed.map((e) => e.level))],
  };
}

function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 10000) / 100;
}

function summarize(snap, source) {
  const tools = {};
  for (const [name, v] of Object.entries(snap.by_tool ?? {})) {
    tools[name] = {
      calls: v.calls,
      ok: v.ok,
      fail: v.fail,
      success_rate_pct: pct(v.ok, v.ok + v.fail),
      x402_issued: v.issued402,
      x402_settled: v.settled,
      paywall_conversion_pct: pct(v.settled, v.issued402),
    };
  }
  return {
    source,
    generated_at: snap.generated_at,
    isolation_basis: snap.isolationBasis,
    persistence: snap.persistence,
    total_events: snap.total_events,
    events: snap.events,
    tools,
  };
}

async function fetchLive(url) {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/metrics`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    return { ok: true, snap: j };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function main() {
  console.log("Stage F4 — 影子经济体看板生成\n");

  // 计数口径只该 reset 一次：多 reset 一次就少一段样本，看板数字会用看上去合理的方式骗人。
  __resetForTest();
  console.log("① 本地流量（X402_MODE=free，目录收录期形态）");
  await generateTraffic({ ...ENV, X402_MODE: "free" }, "free ");

  console.log("② 本地流量（X402_MODE=strict，开始收费的形态）");
  await generateTraffic({ ...ENV, X402_MODE: "strict" }, "strict");

  const mergedSnap = snapshot(ENV);

  const sources = [summarize(mergedSnap, "local-isolate")];

  let liveStatus = { attempted: false };
  if (LIVE) {
    console.log(`④ 拉取线上 /metrics  ${LIVE}`);
    liveStatus = { attempted: true, url: LIVE, ...(await fetchLive(LIVE)) };
    if (liveStatus.ok) {
      console.log(`   ✅ 线上 total_events=${liveStatus.snap.total_events} persistence=${liveStatus.snap.persistence}`);
      sources.push(summarize(liveStatus.snap, "live-metrics"));
    } else {
      console.log(`   ❌ ${liveStatus.error}`);
    }
  } else {
    console.log("④ 线上 /metrics —— 未指定 --live，跳过");
  }

  // ⑤ 日志阈值自检 —— 专门对着那个"坏了也没人发现"的开关。
  //     XAF_LOG_LEVEL=error 时若还在打印 info/warn，说明阈值形同虚设：
  //     线上就会照着这条路把内部事件倒进 CF 日志里。这条不通过，看板不算数。
  const logCheck = await checkLogLevel();
  console.log(`⑤ 日志阈值自检：${logCheck.ok ? "✅" : "❌"} ${logCheck.detail}`);

  // ── 给 X4 的挂钩 ────────────────────────────────────────────────────────
  // RSI 要变异的是"Tool 的商业描述 + 定价"，所以这里必须给出：
  //   每个 tool 的**当前基线**指标 + 一个明确的 fitness 公式，否则它会优化一个空集合。
  const baseline = {};
  for (const s of sources) {
    for (const [name, v] of Object.entries(s.tools)) {
      if (s.source !== "live-metrics") continue;
      baseline[name] = { calls: v.calls, ok: v.ok, settled: v.settled, issued: v.issued402 ?? v.x402_issued };
    }
  }

  const dashboard = {
    schema: "xaf.shadow-dashboard/v1",
    generated_at: new Date().toISOString(),
    node: ENV.XAF_NODE_ID,
    purpose: "X4 RSI 商业变异的 A/B 反馈源；同时是 Stage X-Finale 的运营观测面。",

    sources,

    x4_hooks: {
      mutation_targets: ["tool.description", "tool.title", "tool.price_usd", "tool.tags"],
      fitness: {
        formula: "fitness = 0.6 * normalized(calls) + 0.3 * paywall_conversion_pct + 0.1 * success_rate_pct",
        note: "曝光量占大头但必须有转化率兜底 —— 只优化曝光会得到一堆标题党描述，转化率为 0 等于没收成。",
      },
      redlines_for_mutation: [
        "Mutation 输出的描述不得含无固定之事承诺（保证包过 / 100% 成功 / 稳赚）",
        "不得引入真实法币词汇（Stripe / 支付宝 / 微信支付 / 人民币定价）",
        "不得在主网链上做任何动作：variants 只允许 base-sepolia / polygon-amoy",
        "定价区间锁死 0.01 ~ 1.00 USDC，超出即为 -100 并熔断",
      ],
      baseline: Object.keys(baseline).length ? baseline : null,
      baseline_note: Object.keys(baseline).length
        ? "来自线上 /metrics（isolate 级计数，非全局精确值）。"
        : "线上尚无样本 —— 先看板，后启动变异，别让 RSI 对着空气优化。",
    },

    safety_posture: {
      identity_fields_collected: [],
      note: "事件计数只有 tool/method 维度。没有 IP、UA、Cookie、钱包地址，也没有它们的哈希。",
      privacy_scan_to_run_next: "tools/prepublish_scan.mjs（公开仓库 push 前的硬门禁）",
    },

    live: LIVE
      ? { url: LIVE, reachable: !!liveStatus.ok, error: liveStatus.error ?? null }
      : { url: null, reachable: null, error: "未指定 --live" },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(dashboard, null, 2), "utf8");

  const local = dashboard.sources[0];
  console.log(`\n── 本地模拟结果 ─────────────────────────────`);
  console.log(`   总事件 ${local.total_events}  ${JSON.stringify(local.events)}`);
  for (const [n, v] of Object.entries(local.tools)) {
    console.log(`   ${n.padEnd(20)} calls=${String(v.calls).padStart(3)}  ok=${v.ok}  fail=${v.fail}  success=${v.success_rate_pct}%  402=${v.x402_issued}  settled=${v.x402_settled}`);
  }
  console.log(`\n✅ 看板已写出： ${OUT}`);

  return 0;
}

main().catch((e) => {
  console.error("看板生成失败:", e);
  process.exit(1);
});
