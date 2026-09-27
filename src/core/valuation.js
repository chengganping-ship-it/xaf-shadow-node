/**
 * portfolio_valuation 引擎 —— 估值基准取自
 * scripts/xaf_infinity/digital_rights_engine.py :: TrackB_OwnDataAuthorization.ASSET_INVENTORY
 * 的四条许可价值带（potential_license_value），并补一个可审计、可复算的确定性公式。
 *
 * 公式：
 *   value_cny = base_rate(type) × volume_factor × quality_factor × license_multiplier × horizon - prep_cost
 * ⛔ 估值不承诺收益；⛔ 结算侧只允许测试网 USDC，且本 Tool 不触发任何链上动作。
 */

import { FX_REFERENCE, toAtomicUnits } from "../pricing.js";

/** 资产类别基准（CNY）。区间 lo/hi 来自既有文字描述，不是拍脑袋 */
const TYPE_BASE = {
  interaction_logs: { unit: "条", lo: 0.5, hi: 2.0, note: "真实用户痛点+场景+决策逻辑，稀有度决定单价", anchored_band: "每条¥0.5-2" },
  templates: { unit: "套", lo: 500, hi: 2000, note: "实战验证+转化率数据的话术模板库", anchored_band: "一次性¥500-2000或分成" },
  compliance_kb: { unit: "年", lo: 199, hi: 999, note: "红线规则+安全阀+操作手册，SaaS 授权", anchored_band: "¥199-999/年" },
  dataset: { unit: "条/MB", lo: 0.5, hi: 2.0, note: "合规语料，按量或按数据集整体授权", anchored_band: "参考互动日志带" },
  creative_work: { unit: "件", lo: 300, hi: 3000, note: "图文/视频/设计作品，版权授权一次性或分成", anchored_band: "视作品稀缺度" },
};

/** 授权模式系数（相对一次性买断） */
const LICENSE_MULTIPLIER = {
  one_time: { factor: 1.0, note: "一次性授权买断" },
  subscription: { factor: 2.4, note: "订阅制，按 3 年折算年化溢价" },
  per_unit: { factor: 1.6, note: "按调用/条数计费，总量放大" },
};

/** 未脱敏资产的合规准备成本：按 PII 清洗+人工 review 的既有估算 */
const PREP_COST_CNY = { base: 320, per_asset: 80 };

function clamp01(n) {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

/** 质量系数：0.4 ~ 1.6，线性映射 */
function qualityFactor(q) {
  return Number((0.4 + clamp01(q) * 1.2).toFixed(4));
}

/** 体量因子：对数缩放，避免单条资产直接撑爆估值 */
function volumeFactor(units) {
  if (!Number.isFinite(units) || units <= 0) return 1;
  return Number(Math.log10(units + 9).toFixed(4));
}

function valueOne(asset, index, horizon) {
  const base = TYPE_BASE[asset.type] ?? TYPE_BASE.interaction_logs;
  const q = asset.quality === undefined ? 0.6 : clamp01(asset.quality);
  const model = LICENSE_MULTIPLIER[asset.license_model ?? "one_time"] ?? LICENSE_MULTIPLIER.one_time;
  const vf = (asset.license_model === "per_unit" && asset.volume_units) ? Math.max(volumeFactor(asset.volume_units), Number(asset.volume_units)) : volumeFactor(asset.volume_units ?? 0);
  const qf = qualityFactor(q);
  const prep = asset.anonymized === false ? PREP_COST_CNY.base + PREP_COST_CNY.per_asset * Math.min(index, 10) : 0;

  const low = Number((base.lo * vf * qf * model.factor * horizon - prep).toFixed(2));
  const high = Number((base.hi * vf * qf * model.factor * horizon - prep).toFixed(2));
  const expected = Number(((low + high) / 2).toFixed(2));

  return {
    name: asset.name,
    type: asset.type,
    volume_units: asset.volume_units ?? 0,
    unit: base.unit,
    quality: q,
    quality_factor: qf,
    license_model: asset.license_model ?? "one_time",
    license_factor: model.factor,
    value_cny_low: Math.max(0, low),
    value_cny_high: Math.max(0, high),
    value_cny_expected: Math.max(0, expected),
    value_usd_expected: Number((Math.max(0, expected) / FX_REFERENCE.usd_cny).toFixed(2)),
    prep_cost_cny: prep,
    anchored_band: base.anchored_band,
    note: base.note,
  };
}

/**
 * @param {{assets:Array, horizon_years?:number}} input
 */
export function portfolioValuation(input) {
  const horizon = Math.min(5, Math.max(1, Number(input.horizon_years ?? 1)));
  const rows = input.assets.map((a, i) => valueOne(a, i, horizon));

  const totalExpectedCny = Number(rows.reduce((acc, r) => acc + r.value_cny_expected, 0).toFixed(2));
  const totalLow = Number(rows.reduce((acc, r) => acc + r.value_cny_low, 0).toFixed(2));
  const totalHigh = Number(rows.reduce((acc, r) => acc + r.value_cny_high, 0).toFixed(2));

  const sorted = [...rows].sort((a, b) => b.value_cny_expected - a.value_cny_expected);
  const top = sorted[0];
  // 集中度：最大单资产占比
  const concentration = totalExpectedCny > 0 ? Number((top.value_cny_expected / totalExpectedCny).toFixed(4)) : 0;

  return {
    tool: "portfolio_valuation",
    horizon_years: horizon,
    fx_reference: { pair: "USD/CNY", rate: FX_REFERENCE.usd_cny, note: "仅展示用参考汇率，非结算汇率" },
    portfolio: {
      asset_count: rows.length,
      value_cny_low: totalLow,
      value_cny_high: totalHigh,
      value_cny_expected: totalExpectedCny,
      value_usd_expected: Number((totalExpectedCny / FX_REFERENCE.usd_cny).toFixed(2)),
      value_usdc_atomic_testnet: toAtomicUnits(totalExpectedCny / FX_REFERENCE.usd_cny),
    },
    concentration_top_asset: { name: top.name, share: concentration },
    risk_flags: [
      ...(concentration > 0.6 ? ["集中度过高（>60%）：单一资产失效将显著冲击组合估值"] : []),
      ...(rows.some((r) => r.prep_cost_cny > 0) ? ["存在未脱敏资产：估值已扣减 PII 清洗与人工 review 成本"] : []),
      ...(rows.length < 3 ? ["资产数量 <3：样本稀疏，估值区间置信度低"] : []),
    ],
    recommended_monetization_order: sorted.map((r, i) => ({
      rank: i + 1,
      name: r.name,
      why: `${r.type} / ${r.license_model} / 期望¥${r.value_cny_expected}`,
    })),
    rows,
    disclaimer:
      "估值为基于公开许可价值带的算法测算，不构成收益承诺；任何授权收入取决于实际买方需求。结算探索仅限测试网，禁止主网与法币通道。",
  };
}
