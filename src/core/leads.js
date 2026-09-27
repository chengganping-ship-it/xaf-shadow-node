/**
 * c2c_lead_sniff 引擎 —— 移植 CAND-04 确权关键词五组扩展 + 负向排除（见
 * _xaf_state/digest_pipeline/CAND-04/plan_summary.json 的 5 组清单），
 * 并与 scripts/xaf_infinity/digital_rights_engine.py 的三阶段话术分级对齐。
 *
 * 设计约束：边缘无状态 ⇒ 纯函数、无去重账本；去重指纹（simHash 片段）在结果里返回，
 * 供调用方（XAF 本地 pipeline）落去重，节点本身不记住任何历史消息。
 */

import { checkContentCompliance } from "../safety.js";

/** 五组关键词 —— 组级权重 × 词级权重 */
const KEYWORD_GROUPS = {
  core_confirmation: {
    weight: 1.0,
    words: {
      数据确权: 0.95,
      版权登记: 0.95,
      作品备案: 0.9,
      数字资产登记: 0.88,
      版权存证: 0.85,
      著作权: 0.85,
      知识产权保护: 0.8,
      数据资产化: 0.9,
    },
  },
  infringement: {
    weight: 1.0,
    words: { 被侵权: 0.95, 被盗用: 0.9, 被AI训练: 0.88, 洗稿: 0.85, 抄袭: 0.8, 盗图: 0.8, 维权: 0.75, 投诉: 0.5 },
  },
  monetization_signals: {
    weight: 0.9,
    words: { AI训练授权: 0.92, 授权给AI: 0.9, 数据变现: 0.85, 语料授权: 0.8, 收益分成: 0.7, 变现: 0.6, 授权: 0.5 },
  },
  asset_classes: {
    weight: 0.6,
    words: { 数据集: 0.7, 语料: 0.7, 训练集: 0.7, 小说: 0.6, 插画: 0.6, 设计稿: 0.6, 源码: 0.6, 视频: 0.5, 照片: 0.5 },
  },
  c2c_platform: {
    weight: 0.4,
    words: { 闲鱼: 0.6, 小红书: 0.6, 抖音: 0.5, 知乎: 0.4, 公众号: 0.4, 微信: 0.4, fiverr: 0.6, upwork: 0.6, gumroad: 0.6 },
  },
};

/** 负向排除 —— 命中即判定为噪音，不进入线索池 */
const NEGATIVE_EXCLUSIONS = [
  "免费帮忙",
  "刷单",
  "兼职日结",
  "招聘",
  "诚聘",
  "代做作业",
  "论文代写",
  "赌博",
  "博彩",
  "币圈带单",
  "内幕消息",
  "破解",
  "外挂",
];

const PLATFORM_HINTS = [
  { platform: "xianyu", words: ["闲鱼", "咸鱼", "二手平台"], extrovert: 0.7 },
  { platform: "xiaohongshu", words: ["小红书", "笔记", "薯条"], extrovert: 0.6 },
  { platform: "douyin", words: ["抖音", "短视频"], extrovert: 0.5 },
  { platform: "wechat", words: ["微信", "朋友圈", "公众号"], extrovert: 0.6 },
  { platform: "fiverr", words: ["fiverr", "gig"], extrovert: 0.8 },
  { platform: "upwork", words: ["upwork", "freelancer"], extrovert: 0.8 },
];

const SKU_MATCH = [
  { sku: "prepack-submit", name: "数据资产确权代提交服务", price_cny: 99.0, groups: ["core_confirmation", "monetization_signals"] },
  { sku: "prepack-license", name: "AI训练数据授权代理", price_cny: 49.9, groups: ["monetization_signals", "asset_classes"] },
  { sku: "prepack-basic", name: "AI辅助版权登记预审包", price_cny: 29.9, groups: ["core_confirmation", "infringement"] },
];

/** 极简文本指纹（不做持久化，仅供调用方去重） */
function fingerprint(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `fp-${h.toString(16).padStart(8, "0")}`;
}

function sniffOne(raw, threshold) {
  const text = String(raw ?? "");
  const lower = text.toLowerCase();
  const scoreInfo = { raw: 0, groups: {}, matched: [] };

  for (const [group, cfg] of Object.entries(KEYWORD_GROUPS)) {
    let groupScore = 0;
    for (const [word, w] of Object.entries(cfg.words)) {
      const hay = /^[a-z]+$/.test(word) ? lower : text;
      if (hay.includes(word)) {
        groupScore += w;
        scoreInfo.matched.push({ keyword: word, group, weight: Number((w * cfg.weight).toFixed(3)) });
      }
    }
    if (groupScore > 0) {
      scoreInfo.groups[group] = Number((groupScore * cfg.weight).toFixed(3));
      scoreInfo.raw += groupScore * cfg.weight;
    }
  }

  const noise = NEGATIVE_EXCLUSIONS.filter((n) => text.includes(n));
  const platforms = PLATFORM_HINTS.filter((p) => p.words.some((w) => lower.includes(w))).map((p) => p.platform);

  const normalized = Math.min(1, scoreInfo.raw / 3);
  const blocked = noise.length > 0;
  const score = blocked ? 0 : Number(normalized.toFixed(4));
  const qualifies = !blocked && score >= threshold;

  let priority = "NOISE";
  if (!blocked) priority = score >= 0.6 ? "HOT" : score >= 0.3 ? "WARM" : qualifies ? "COLD" : "BELOW_THRESHOLD";

  const sku =
    SKU_MATCH.map((s) => ({ s, hit: s.groups.filter((g) => scoreInfo.groups[g]).length }))
      .sort((a, b) => b.hit - a.hit)[0]?.s ?? SKU_MATCH[2];

  const compliance = checkContentCompliance(text);

  return {
    fingerprint: fingerprint(text),
    score,
    priority,
    blocked_reason: blocked ? `负向排除命中: ${noise.join("/")}` : null,
    groups_hit: scoreInfo.groups,
    matched: scoreInfo.matched,
    platforms,
    length: text.length,
    pii_masked: compliance.pii_masked,
    recommended_service: priority === "NOISE" ? null : { sku: sku.sku, name: sku.name, price_cny: sku.price_cny },
    suggested_stage: priority === "HOT" ? "stage3" : priority === "WARM" ? "stage2" : priority === "COLD" ? "stage1" : "none",
    excerpt_masked: compliance.sanitized.slice(0, 120),
  };
}

/**
 * @param {{messages?:string[], text?:string, threshold?:number}} input
 */
export function c2cLeadSniff(input) {
  const threshold = typeof input.threshold === "number" ? input.threshold : 0.6;
  const messages = Array.isArray(input.messages) && input.messages.length
    ? input.messages
    : input.text
      ? [input.text]
      : [];

  const results = messages.map((m) => sniffOne(m, threshold));
  const bucket = { HOT: 0, WARM: 0, COLD: 0, NOISE: 0, BELOW_THRESHOLD: 0 };
  for (const r of results) bucket[r.priority] = (bucket[r.priority] ?? 0) + 1;

  const qualified = results.filter((r) => ["HOT", "WARM", "COLD"].includes(r.priority));
  const ranked = [...qualified].sort((a, b) => b.score - a.score).slice(0, 10);

  const estPipelineCny = Number(
    qualified.reduce((acc, r) => acc + (r.recommended_service?.price_cny ?? 0), 0).toFixed(2),
  );

  return {
    tool: "c2c_lead_sniff",
    threshold,
    scanned: results.length,
    summary: bucket,
    qualified_count: qualified.length,
    estimated_pipeline_cny: estPipelineCny,
    top_leads: ranked.map((r) => ({
      fingerprint: r.fingerprint,
      score: r.score,
      priority: r.priority,
      platforms: r.platforms,
      suggested_stage: r.suggested_stage,
      recommended_service: r.recommended_service,
      excerpt_masked: r.excerpt_masked,
    })),
    results: input.messages?.length ? results : undefined,
    disclaimer: "嗅探结果仅做线索前置过滤，不构成邀约；对外话术须经确权合规校验后方可使用。",
  };
}
