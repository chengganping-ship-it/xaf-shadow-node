/**
 * 把线上 Worker 的真实 manifest 抓回来，写成 X2 提交包里的对外凭证。
 * =========================================================
 * 为什么不用本地生成：**因为上一轮的教训就是"文档说自己是这样，实际不是那样"**。
 * 本地generate 的 manifest 是"我以为线上的样子"，可能因为 wrangler vars、
 * 部署版本、变量覆盖而与线上不一致。直接读线上响应，文档才等于现实。
 *
 * 用法： node tools/sync_manifest.mjs https://xaf-shadow-node.<sub>.workers.dev
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "x2_packet", "manifest.json");

const url = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!url) {
  console.error("用法: node tools/sync_manifest.mjs <worker-base-url>");
  process.exit(2);
}

async function get(path) {
  const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 就算了 */
  }
  return { status: res.status, json, text };
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log(`\n同步线上 manifest ← ${url}\n`);

const m = await get("/manifest");
check("GET /manifest 返回 200", m.status === 200, `HTTP ${m.status}`);
if (m.status !== 200) {
  console.error("\n上线 manifest 抓不到，提交包不生成 —— 不能拿本地快照冒充线上状态。");
  process.exit(1);
}

const health = await get("/health");
const metrics = await get("/metrics");
const tools = await get("/mcp");

check("在线 self-describe 的工具数为 3", Array.isArray(m.json?.tools) && m.json.tools.length === 3, `tools=${m.json?.tools?.length}`);
check("支付网络为测试网 base-sepolia", m.json?.payment?.network === "base-sepolia", `network=${m.json?.payment?.network} chain=${m.json?.payment?.chain_id}`);
check("主网熔断已布防", m.json?.payment?.mainnet_fuse === "armed", `mainnet_fuse=${m.json?.payment?.mainnet_fuse}`);
check("声明零法币网关", m.json?.payment?.fiat_gateways === "none", `fiat_gateways=${m.json?.payment?.fiat_gateways}`);
check("/health 存活", health.status === 200, `HTTP ${health.status}`);
check(
  "/metrics 存在且不含身份字段",
  metrics.status === 200 && Array.isArray(metrics.json?.privacy?.identity_fields_recorded) && metrics.json.privacy.identity_fields_recorded.length === 0,
  metrics.status === 200 ? `identity_fields=${JSON.stringify(metrics.json?.privacy?.identity_fields_recorded)}` : `HTTP ${metrics.status}`,
);

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};

const doc = {
  schema: "xaf.mcp-manifest/v1",
  synced_at: new Date().toISOString(),
  source: "live-endpoint",
  source_url: url,
  endpoint: `${url}/mcp`,
  transport: m.json.transport,
  node: {
    name: m.json.name,
    node_id: m.json.node_id,
    toolset_version: m.json.toolset_version,
  },
  tools: m.json.tools,
  payment: m.json.payment,
  safety: m.json.safety,
  probe: {
    manifest_status: m.status,
    health_status: health.status,
    metrics_status: metrics.status,
    root_status: tools.status,
    all_ok: checks.every((c) => c.ok),
  },
  checks,
  // 上一版保留以便对照；若两次不一致，说明配置漂移 —— 故意留痕而不是静默覆盖
  previous_sync: previous.synced_at ? { synced_at: previous.synced_at, tool_count: previous.tools?.length } : null,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc, null, 2), "utf8");

const failed = checks.filter((c) => !c.ok);
console.log(`\n结论: ${failed.length === 0 ? "✅ 线上状态与提交包一致" : `❌ ${failed.length} 项不符`}`);
console.log(`写出: ${OUT}\n`);
process.exit(failed.length === 0 ? 0 : 1);
