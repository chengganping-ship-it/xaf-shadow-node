/**
 * Phase X 安全阀 —— 编译进 Gateway 的红线，不是文档里的承诺。
 *
 * 四条硬熔断：
 *   A. 主网熔断：任何 chainId ∉ {84532, 80002} → 抛错，请求不可能被放行。
 *   B. 法币网关熔断：任何配置/入参出现 Stripe/支付宝/微信支付/Gumroad 结算 → 抛错。
 *   C. 违规承诺熔断：确权赛道禁止"保证通过/100%拿证"等承诺词（源自 rights engine）。
 *   D. 隐私熔断：手机号/身份证/邮箱/银行卡自动脱敏，绝不回显原文。
 */

import { AppError, safetyViolation } from "./errors.js";

/** 允许的测试网白名单。改这里 = 改红线，必须走变更评审。 */
export const TESTNET_CHAINS = Object.freeze({
  84532: { network: "base-sepolia", label: "Base Sepolia", native: "ETH" },
  80002: { network: "polygon-amoy", label: "Polygon Amoy", native: "POL" },
});

/** 主网黑名单 —— 出现即熔断，哪怕只是被"提到"。 */
export const MAINNET_CHAINS = new Set([1, 56, 137, 8453, 42161, 10, 59144, 501]);

export const NETWORK_ALIASES = Object.freeze({
  "base-sepolia": 84532,
  "polygon-amoy": 80002,
});

/** 真实法币网关 —— Phase X 全程零接触。 */
export const FIAT_GATEWAY_TOKENS = Object.freeze([
  "stripe",
  "alipay",
  "wechatpay",
  "weixin-pay",
  "wxpay",
  "paypal",
  "gumroad-checkout",
  "lemon-squeezy",
  "lemonsqueezy",
]);

/** 源自 scripts/xaf_infinity/digital_rights_engine.py :: RightsSafetyValve.FORBIDDEN_CLAIMS */
export const FORBIDDEN_CLAIMS = Object.freeze([
  "保证通过",
  "保底",
  "100%拿证",
  "一定能成功",
  "确保获得",
  "官方内部渠道",
  "加急包过",
  "100%下证",
  "确保审核通过",
]);

const PII_RULES = [
  { label: "手机号", re: /1[3-9]\d{9}/g },
  { label: "身份证", re: /\b\d{17}[\dXx]\b/g },
  { label: "邮箱", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { label: "银行卡", re: /\b\d{16,19}\b/g },
  { label: "微信号", re: /\b(?:wxid|wx)[_-]?[A-Za-z0-9_]{5,20}\b/g },
];

/**
 * A. 主网熔断。入参 label 用于审计日志。
 * @throws {AppError} 当 chainId 落在主网或不在测试网白名单
 */
export function assertTestnet(chainId, label = "unknown") {
  if (MAINNET_CHAINS.has(chainId)) {
    throw safetyViolation(`在主网 chainId=${chainId} 上检测到结算意图，已熔断`, {
      redline: "A-mainnet-fuse",
      chainId,
      label,
      allowed: Object.keys(TESTNET_CHAINS).map(Number),
    });
  }
  if (!TESTNET_CHAINS[chainId]) {
    throw safetyViolation(`不受支持的 chainId=${chainId}，仅允许测试网`, {
      redline: "A-mainnet-fuse",
      chainId,
      label,
      allowed: Object.keys(TESTNET_CHAINS).map(Number),
    });
  }
  return TESTNET_CHAINS[chainId];
}

/** 解析网络名 → chainId；失败即熔断（未知网名/主网名都会炸）。 */
export function resolveNetwork(name) {
  const raw = String(name ?? "");
  const id = NETWORK_ALIASES[raw.toLowerCase()];
  if (id === undefined) {
    throw safetyViolation(`network 字段「${raw}」不在测试网白名单内，仅允许 ${Object.keys(NETWORK_ALIASES).join(" / ")}`, {
      redline: "A-mainnet-fuse",
      network: raw,
      allowed: Object.keys(NETWORK_ALIASES),
    });
  }
  const meta = assertTestnet(id, `resolveNetwork(${raw})`);
  return { chainId: id, ...meta };
}

/**
 * B. 法币网关熔断。扫描任意配置对象/env 的字符串值。
 * @throws {AppError}
 */
export function assertNoFiatGateway(candidate, label = "config") {
  const flat = typeof candidate === "string" ? candidate : JSON.stringify(candidate ?? "");
  const hay = flat.toLowerCase();
  for (const token of FIAT_GATEWAY_TOKENS) {
    if (hay.includes(token)) {
      throw safetyViolation(`检测到真实法币网关引用「${token}」，Phase X 禁止触碰`, {
        redline: "B-fiat-fuse",
        token,
        label,
      });
    }
  }
  return true;
}

/**
 * C+D. 内容合规检查（移植 RightsSafetyValve.check_rights_compliance）。
 * 返回 { passed, violations[], sanitized }，sanitized 为可安全回显的文本。
 */
export function checkContentCompliance(content) {
  let sanitized = String(content ?? "");
  const violations = [];

  for (const claim of FORBIDDEN_CLAIMS) {
    if (sanitized.includes(claim)) {
      violations.push(`违规承诺: ${claim}`);
      sanitized = sanitized.split(claim).join("[已删除-违规承诺]");
    }
  }

  for (const rule of PII_RULES) {
    if (rule.re.test(sanitized)) {
      rule.re.lastIndex = 0;
      sanitized = sanitized.replace(rule.re, `[已脱敏-${rule.label}]`);
      violations.push(`包含${rule.label}，已自动脱敏`);
    }
    rule.re.lastIndex = 0;
  }

  return {
    passed: violations.filter((v) => v.startsWith("违规承诺")).length === 0,
    violations,
    sanitized,
    pii_masked: violations.some((v) => v.includes("已自动脱敏")),
  };
}

/** 统一的安全生产不同 Everything-must-pass 入口；返回第一个违规。 */
export function guardTopLevelEnv(env) {
  const issues = [];
  try {
    assertNoFiatGateway(env.X402_FACILITATOR_URL, "X402_FACILITATOR_URL");
    assertNoFiatGateway(env.XAF_TESTNET_PAYTO, "XAF_TESTNET_PAYTO");
  } catch (e) {
    if (e instanceof AppError) issues.push(e.toJSON());
  }
  try {
    resolveNetwork(env.X402_NETWORK);
  } catch (e) {
    if (e instanceof AppError) issues.push(e.toJSON());
  }
  return issues;
}
