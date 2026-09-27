/**
 * 匿名事件计数（Stage F4）
 * =========================================================
 * 目的：给 X4 的 RSI 商业变异提供真实反馈源 —— 哪些 Tool 被问、多少次、有没有付费。
 *
 * 红线（写代码前先读，改代码前再读）：
 *   1. **绝不记录 IP / UA / Cookie / Referer / CF-Ray / 地理位置**。
 *      本文件是全局唯一允许「碰请求」的遥测点，所以它自己立誓：签名里根本不接受 Request 对象，
 *      只接受调用方从别处算好的纯标量（tool 名、事件名、数值）。
 *      拿不到这些字段 ⇒ 不是"忘了"，是"架构上不可能"。
 *   2. 不做 fingerprint：没有 hash(IP)、没有 hash(UA)、没有 hash(IP+UA)。
 *      "换个名字的同一个东西"依然是那个东西 —— 不做这种自欺的实现。
 *   3. 无 KV / D1 / R2 强依赖：默认只在 isolate 内存里累加，重启归零。
 *      这一点写在 /metrics 的返回值里明说，不伪装成持久计数器。
 *   4. 可选持久化走 Workers Analytics Engine（\(ANALYTICS 绑定）。
 *      有绑定就双写；没有就只留内存，行为同样是"计数"，不报错。
 *
 * 事件口径（固定，供 X4 消费）：
 *   rpc_handled  一次 JSON-RPC 请求被处理（按 method 分）
 *   x402_issued  下发 402（有人在收费口被拦）
 *   x402_settled 结算成功（有人真的付了）
 *   tool_ok / tool_fail  单个 Tool 的执行结果
 */

/** isolate 级计数表。Workers 会复用/回收 isolate，所以它 **不是** 全局精确值。 */
const counters = new Map();
const bootedAt = Date.now();

/** 那些一旦写进去就成了身份信息的字段 —— 显式拒绝，而不是靠自觉。 */
const FORBIDDEN_KEYS = new Set([
  "ip", "ip_address", "client_ip", "cf-connecting-ip", "cf_connecting_ip",
  "ua", "user_agent", "user-agent", "cf-ray", "cfray", "ray",
  "cookie", "referer", "referrer", "cf-ipcountry", "country", "colo",
  "email", "wallet", "address", "payer", "tx_hash", "signature", "authorization",
]);

const EVENTS = new Set(["rpc_handled", "x402_issued", "x402_settled", "tool_ok", "tool_fail"]);

/**
 * 计数一次。刻意不抛异常 —— 遥测永远不该弄挂业务路径。
 * @param {object} env   Worker env（可能含 XAF_TELEMETRY 绑定）
 * @param {string} event 事件名，必须在 EVENTS 白名单内
 * @param {object} [dim] 维度，只允许 tool / method / chain 三个标量 key
 */
export function record(env, event, dim = {}) {
  try {
    if (!EVENTS.has(event)) return;
    const tool = typeof dim.tool === "string" ? dim.tool.slice(0, 64) : "";
    const method = typeof dim.method === "string" ? dim.method.slice(0, 64) : "";
    const key = `${event}|tool=${tool}|method=${method}`;

    counters.set(key, (counters.get(key) ?? 0) + 1);

    // 越权扫描：只要调用方试图塞身份字段，整条遥测丢弃并留一条内部迹象（不含被拒内容）。
    // 写这条是因为"某个未来的改动想加个 country 统计"是完全可以预见的事。
    for (const k of Object.keys(dim)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) {
        counters.set(`__rejected|${k}`, (counters.get(`__rejected|${k}`) ?? 0) + 1);
        return;
      }
    }

    writeAnalytics(env, event, tool, method);
  } catch {
    /* 遥测失败吞掉 —— 宁可丢一条计数，也不让 /mcp 挂掉 */
  }
}

/**
 * 双写到 Workers Analytics Engine（可选）。
 * blobs 只放 tool/method 这类低基数枚举；doubles 放计数；
 * index 用 tool 做抽样查询键（AE 要求 index ≤ 96 字节，slice 保底）。
 */
function writeAnalytics(env, event, tool, method) {
  const ae = env?.XAF_TELEMETRY;
  if (!ae || typeof ae.writeDataPoint !== "function") return;
  ae.writeDataPoint({
    blobs: [event, tool || "-", method || "-"],
    doubles: [1],
    indexes: [(tool || "none").slice(0, 96)],
  });
}

/**
 * 导出快照。用于 /metrics 与本地回读。
 * isolationBasis 明写 "isolate-memory"，让消费方知道这不是持久值 —— 这是防腐层，
 * 免得 X4 拿着一份会随机归零的计数，去优化一个根本不存在的信号。
 */
export function snapshot(env) {
  const events = {};
  const byTool = {};
  let total = 0;

  for (const [key, n] of counters) {
    if (key.startsWith("__rejected|")) continue;
    const [event, ...rest] = key.split("|");
    const tool = (rest.find((r) => r.startsWith("tool=")) ?? "tool=").slice(5);
    events[event] = (events[event] ?? 0) + n;
    total += n;
    if (tool) {
      byTool[tool] = byTool[tool] ?? { calls: 0, ok: 0, fail: 0, settled: 0, issued402: 0 };
      byTool[tool].calls += n;
      if (event === "tool_ok") byTool[tool].ok += n;
      if (event === "tool_fail") byTool[tool].fail += n;
      if (event === "x402_settled") byTool[tool].settled += n;
      if (event === "x402_issued") byTool[tool].issued402 += n;
    }
  }

  const rejected = [...counters.entries()]
    .filter(([k]) => k.startsWith("__rejected|"))
    .map(([k, n]) => ({ field: k.slice(11), attempts: n }));

  return {
    node: env?.XAF_NODE_ID ?? "unknown",
    toolset_version: env?.XAF_TOOLSET_VERSION ?? "unknown",
    x402_mode: env?.X402_MODE ?? "unknown",
    generated_at: new Date().toISOString(),
    isolationBasis: "isolate-memory",
    persistence: env?.XAF_TELEMETRY ? "workers-analytics-engine" : "none (reset on isolate recycle)",
    honesty: {
      exact: false,
      reason: "Workers 会在任意时刻回收 isolate；此计数是「某段寿命内的观测」而非全局真值。X4 做 A/B 决策时不要把单次 diff 当结论。",
    },
    uptime_ms: Date.now() - bootedAt,
    total_events: total,
    events,
    by_tool: byTool,
    privacy: {
      identity_fields_recorded: [],
      note: "不记录 IP / UA / Cookie / 地理位置 / 钱包地址；也没有这些字段的哈希形式。",
    },
    rejected_attempts: rejected,
  };
}

/** 测试用：清空计数。生产路径不会调用。 */
export function __resetForTest() {
  counters.clear();
}
