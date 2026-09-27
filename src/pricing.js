/**
 * 定价与 x402 Payment Requirements 构造。
 *
 * 口径继承 products/x402_middleware.py :: TOOL_PRICING_USD / DAILY_FREE_QUOTA，
 * 并按 docs/learning/deep_research/x402-mcp-monetization-2026.md 的 $0.001-$1.00 区间做校正。
 *
 * ⛔ 本模块不发起任何链上写操作，也不存在任何法币通道。
 */

import { invalidParams } from "./errors.js";
import { resolveNetwork } from "./safety.js";

/** USDC 6 位精度 */
export const USDC_DECIMALS = 6;

/** 工具定价（USD / 次） */
export const TOOL_PRICING_USD = Object.freeze({
  rights_precheck: 0.1,
  c2c_lead_sniff: 0.05,
  portfolio_valuation: 0.2,
});

/** 默认每日免费额度（可被 wrangler vars 覆盖） */
export const DEFAULT_FREE_QUOTA = Object.freeze({
  rights_precheck: 3,
  c2c_lead_sniff: 5,
  portfolio_valuation: 2,
});

/** 溢出 ¥/$ 展示用参考汇率（仅展示，不走任何结算） */
export const FX_REFERENCE = Object.freeze({ usd_cny: 7.2 });

export function priceOf(tool) {
  const p = TOOL_PRICING_USD[tool];
  if (p === undefined) throw invalidParams(`未定价的工具: ${tool}`, { tool });
  return p;
}

export function parseFreeQuota(raw) {
  if (!raw) return { ...DEFAULT_FREE_QUOTA };
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_FREE_QUOTA, ...parsed };
  } catch {
    return { ...DEFAULT_FREE_QUOTA };
  }
}

/** USD → 最小单位字符串（USDC 6dp） */
export function toAtomicUnits(usd, decimals = USDC_DECIMALS) {
  const units = BigInt(Math.round(Number(usd) * 10 ** decimals));
  return units.toString();
}

/**
 * 构造 x402 accept 结构（v1 形态，与 Cloudflare x402 / Coinbase CDP 兼容子集）。
 * network 字段由 resolveNetwork 强制测试网 —— 传主网名会直接熔断。
 */
export function buildPaymentRequirements({ tool, resource, payTo, asset, networkName, env }) {
  const priceUsd = priceOf(tool);
  const { chainId, network } = resolveNetwork(networkName || env?.X402_NETWORK);

  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network,
        chainId,
        maxAmountRequired: toAtomicUnits(priceUsd),
        resource,
        description: `XAF ${tool} — stateless MCP tool call (testnet settlement only)`,
        mime: "application/json",
        payTo: payTo || env?.XAF_TESTNET_PAYTO || "0x0000000000000000000000000000000000000000",
        asset: asset || env?.XAF_TESTNET_USDC,
        maxTimeoutSeconds: 300,
        decimals: USDC_DECIMALS,
        extra: {
          network_label: chainId === 84532 ? "Base Sepolia" : "Polygon Amoy",
          testnet_only: true,
          price_usd: priceUsd,
          price_display_cny: Number((priceUsd * FX_REFERENCE.usd_cny).toFixed(2)),
        },
      },
    ],
  };
}

export function pricingTable() {
  return Object.entries(TOOL_PRICING_USD).map(([tool, usd]) => ({
    tool,
    price_usd: usd,
    price_display_cny: Number((usd * FX_REFERENCE.usd_cny).toFixed(2)),
    atomic_usdc: toAtomicUnits(usd),
  }));
}
