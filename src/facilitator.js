/**
 * x402 Facilitator 客户端 —— Worker 侧只做 HTTP，链上密码学交给 facilitator。
 *
 * 为什么不在 Worker 里自己验签？
 *   1. 免费层 Worker 体积只有 1 MiB（gzip 后），塞 ethers/secp256k1 不划算；
 *   2. USDC 的 domain(name/version/chainId/verifyingContract) 需要按链查，facilitator 天然带这份知识；
 *   3. x402 标准里 resource server 本来就该调 facilitator（Coinbase CDP / PayAI 都是这个形态）。
 *
 * ⛔ 红线：facilitator URL 会被 Fiat 熔断扫描；凭证只放 header，绝不进日志。
 */

import { assertNoFiatGateway } from "./safety.js";

function authHeaders(env) {
  return env?.X402_FACILITATOR_API_KEY ? { authorization: `Bearer ${env.X402_FACILITATOR_API_KEY}` } : {};
}

/**
 * @param {"verify"|"settle"|"supported"} action
 * @returns {Promise<{ok:true,data:object}|{ok:false,reason:string,status?:number,detail?:string}>}
 */
export async function callFacilitator(env, action, payload) {
  const base = String(env?.X402_FACILITATOR_URL ?? "").trim();
  if (!base) return { ok: false, reason: "facilitator_not_configured" };

  try {
    assertNoFiatGateway(base, "X402_FACILITATOR_URL");
  } catch {
    return { ok: false, reason: "facilitator_url_blocked_by_fiat_fuse" };
  }
  if (!/^https?:\/\//i.test(base)) return { ok: false, reason: "facilitator_url_invalid_scheme" };

  const url = `${base.replace(/\/+$/, "")}/${action}`;
  const timeoutMs = Math.min(15000, Math.max(500, Number(env?.X402_FACILITATOR_TIMEOUT_MS ?? 4000)));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(env) },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, reason: "facilitator_bad_json", status: res.status };
    }
    if (!res.ok) return { ok: false, reason: "facilitator_http_error", status: res.status, detail: data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: ctrl.signal.aborted ? "facilitator_timeout" : "facilitator_unreachable", detail: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 标准三段式：
 *   verify  → 签名/额度/时效/nonce 是否成立（不放钱）
 *   settle  → 真正广播链上交易（facilitator 或 None）
 * deliver   → 拿到 settle 凭证后才把数据交给调用方
 */
export async function verifyPayment(env, paymentPayload, paymentRequirements) {
  const r = await callFacilitator(env, "verify", { paymentPayload, paymentRequirements });
  if (!r.ok) return { valid: false, reason: r.reason, stage: "facilitator_verify", detail: r.detail };
  const d = r.data ?? {};
  if (d.isValid === false) return { valid: false, reason: d.invalidReason ?? "invalid_payment", stage: "facilitator_verify", payer: d.payer };
  return { valid: true, payer: d.payer, stage: "facilitator_verify" };
}

export async function settlePayment(env, paymentPayload, paymentRequirements) {
  const r = await callFacilitator(env, "settle", { paymentPayload, paymentRequirements });
  if (!r.ok) return { settled: false, reason: r.reason, detail: r.detail };
  const d = r.data ?? {};
  if (d.success === false) return { settled: false, reason: d.errorReason ?? "settle_failed" };
  return {
    settled: true,
    txHash: d.transaction ?? null,
    network: d.network ?? requirementsNetwork(paymentRequirements),
    payer: d.payer,
    simulated: Boolean(d.simulated),
  };
}

export function requirementsNetwork(reqs) {
  return reqs?.accepts?.[0]?.network ?? null;
}
