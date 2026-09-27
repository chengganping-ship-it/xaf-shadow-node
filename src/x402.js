/**
 * x402 支付门禁 —— 三段式：verify → settle → deliver。
 *
 * 移植 products/x402_middleware.py 的语义，落地到 Workers Fetch API（无 sqlite / Starlette）。
 * 阶段职责：
 *   X1  : mode=free 默认；structure check + 标准 402 Payment Requirements
 *   X3+ : mode=strict + facilitator ⇒ 真实 EIP-3009 验签 → 结算 → 才交付数据
 *
 * ⛔ 红线：
 *   A. network 永远来自 resolveNetwork()，主网值当场熔断，不可能出现在 402 payload
 *   B. facilitator URL 过法币网关熔断
 *   C. 验签失败/额度不足/过期/nonce 重放 ⇒ 一律不给数据
 *   D. 无持久层 ⇒ 不假装记得每日额度
 */

import { AppError, paymentRequired } from "./errors.js";
import { assertNoFiatGateway, assertTestnet, NETWORK_ALIASES } from "./safety.js";
import { buildPaymentRequirements, parseFreeQuota, priceOf, toAtomicUnits } from "./pricing.js";
import { verifyPayment as verifyWithFacilitator, settlePayment } from "./facilitator.js";

const MODES = new Set(["free", "simulation", "strict"]);

function modeOf(env) {
  const m = String(env?.X402_MODE ?? "free").toLowerCase();
  return MODES.has(m) ? m : "free";
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function readPaymentHeader(request) {
  const raw = request.headers.get("x-payment");
  if (!raw || raw.length < 16) return null;
  try {
    return JSON.parse(b64urlDecode(raw));
  } catch {
    try {
      return JSON.parse(raw);
    } catch {
      return { __malformed: true, rawHead: raw.slice(0, 32) };
    }
  }
}

/** 纯本地结构+红线校验：不是validity proof，但能零开销挡掉垃圾与主网凭证 */
export function structuralCheck(proof, env, requirements) {
  if (!proof) return { ok: false, reason: "no_payment_header", stage: "local" };
  if (proof.__malformed) return { ok: false, reason: "malformed_payment_header", stage: "local" };

  const chainId = NETWORK_ALIASES[String(proof.network ?? "").toLowerCase()];
  try {
    assertTestnet(chainId, "x402-proof.network");
  } catch (e) {
    return { ok: false, reason: "network_not_allowed", stage: "local", detail: e instanceof AppError ? e.toJSON() : String(e) };
  }
  try {
    assertNoFiatGateway(proof, "x402-proof");
  } catch (e) {
    return { ok: false, reason: "fiat_gateway_reference_blocked", stage: "local", detail: e instanceof AppError ? e.toJSON() : String(e) };
  }

  const accept = requirements.accepts[0];
  const auth = proof?.payload?.authorization ?? {};
  const required = ["from", "to", "value", "validAfter", "validBefore", "nonce"];
  const missing = required.filter((k) => auth[k] === undefined || auth[k] === null);
  if (missing.length) return { ok: false, reason: "authorization_incomplete", stage: "local", missing };
  if (!proof?.payload?.signature) return { ok: false, reason: "signature_missing", stage: "local" };

  if (String(auth.to).toLowerCase() !== String(accept.payTo).toLowerCase()) {
    return { ok: false, reason: "payto_mismatch", stage: "local", expected: accept.payTo };
  }

  const need = BigInt(accept.maxAmountRequired);
  let paid = BigInt(-1);
  try {
    paid = BigInt(String(auth.value));
  } catch {
    return { ok: false, reason: "value_unparseable", stage: "local" };
  }
  if (paid < need) return { ok: false, reason: "insufficient_amount", stage: "local", need: need.toString(), paid: paid.toString() };

  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validAfter) > now) return { ok: false, reason: "not_yet_valid", stage: "local" };
  if (Number(auth.validBefore) <= now) return { ok: false, reason: "payment_expired", stage: "local" };

  return { ok: true, payer: auth.from, amount: paid.toString(), chainId };
}

/** 一次性构建本次调用的 Payment Requirements（make + verify + settle 复用同一份） */
export function requirementsFor(tool, url, env) {
  return buildPaymentRequirements({ tool, resource: `${url.origin}${url.pathname}?tool=${tool}`, env });
}

function rejected(env, tool, requirements, verdict) {
  const body = {
    error: "Payment Required (x402)",
    x402Version: 1,
    ...requirements,
    verification: verdict,
    hint: { networkAllowed: Object.keys(NETWORK_ALIASES), testnetOnly: true, mainnetFuse: "armed" },
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-price-usd": String(priceOf(tool)),
      "x-payment-required": "true",
      "x-x402-network": requirements.accepts[0].network,
    },
  });
}

/**
 * 门禁入口。
 * @returns {{allowed:true, receipt:object, settle:Function} | {allowed:false, response:Response}}
 * settle 在工具执行成功后调用；X1 未配置 facilitator 时返回 {settled:false, simulated:true}。
 */
export function guardToolCall({ request, url, tool, env }) {
  const mode = modeOf(env);
  const requirements = requirementsFor(tool, url, env);

  if (mode === "free") {
    return {
      allowed: true,
      receipt: { mode, tool, metered: false, testnet_only: true, settlement: "free-pass" },
      settle: async () => ({ settled: false, simulated: true, reason: "free_mode" }),
    };
  }

  const proof = readPaymentHeader(request);
  const local = structuralCheck(proof, env, requirements);
  if (!local.ok) return { allowed: false, response: rejected(env, tool, requirements, local) };

  if (mode === "simulation") {
    return {
      allowed: true,
      receipt: { mode, tool, metered: true, settlement: "simulated", payer: local.payer, amount: local.amount },
      settle: async () => ({ settled: false, simulated: true, amount: local.amount, payer: local.payer }),
    };
  }

  // strict：真正的 verify / settle 由 facilitator 完成（异步，故返回一个 Promise 化的门禁）
  const gated = (async () => {
    const verdict = await verifyWithFacilitator(env, proof, requirements);
    if (!verdict.valid) return { allowed: false, response: rejected(env, tool, requirements, verdict) };
    return {
      allowed: true,
      receipt: { mode, tool, metered: true, payer: verdict.payer ?? local.payer, amount: local.amount, network: requirements.accepts[0].network },
      settle: () => settlePayment(env, proof, requirements),
    };
  })();

  return { promise: gated };
}

function parseJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function quotaSnapshot(env) {
  return {
    free_quota: parseFreeQuota(env?.XAF_FREE_QUOTA_JSON),
    metering_backend: env?.XAF_METER ? "kv" : "stateless-disabled",
    note: env?.XAF_METER ? undefined : "无 KV 绑定：每日额度计数不可用，当前按全局 free 模式放行。",
    chains_verified: parseJson(env?.XAF_CHAINS_VERIFIED, {}),
  };
}

export { toAtomicUnits };
