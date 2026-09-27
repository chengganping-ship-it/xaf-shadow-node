/**
 * rights_precheck 引擎 —— 移植自 scripts/xaf_infinity/digital_rights_engine.py
 * (TrackA_RightsServiceC2C + RightsResourceFreeList + RightsSafetyValve)，
 * 剥离所有本地文件 I/O 与 Python 依赖，改造为 Workers 可用的纯函数。
 *
 * 关键差异（相对 Python 原版）：
 *   - 不再写 storage/xaf_infinity/*.jsonl（边缘节点无持久状态）
 *   - 返回结构体保持一致字段名，便于产物对账
 *   - 合规检查下沉到 src/safety.js 的红线实现
 */

import { checkContentCompliance } from "../safety.js";

/** 意图关键词权重 —— 与 TrackA_RightsServiceC2C.RIGHTS_KEYWORDS 逐条对齐 */
const RIGHTS_KEYWORDS = {
  core_confirmation: {
    数据确权: 0.95,
    作品备案: 0.9,
    数字资产登记: 0.88,
    版权存证: 0.85,
    数据资产化: 0.9,
    著作权登记: 0.85,
  },
  infringement: {
    被侵权: 0.95,
    被盗用: 0.9,
    被AI训练: 0.88,
    抄袭: 0.8,
    洗稿: 0.85,
    盗图: 0.8,
  },
  medium_intent: {
    怎么登记: 0.7,
    需要多少钱: 0.75,
    流程是什么: 0.65,
    有什么好处: 0.6,
    有什么用途: 0.55,
  },
  pain_points: {
    被侵权: 0.95,
    被盗用: 0.9,
    被AI训练: 0.88,
    不知道怎么保护: 0.8,
    想让数据产生价值: 0.75,
  },
  monetization: {
    AI训练授权: 0.92,
    数据变现: 0.85,
    授权给AI: 0.9,
    收益分成: 0.7,
    语料授权: 0.8,
  },
};

const ASSET_PATTERNS = [
  { type: "personal_data", words: ["消费记录", "行为数据", "个人数据", "浏览记录", "账号数据"] },
  { type: "dataset", words: ["数据集", "语料", "问答记录", "训练数据", "爬虫数据"] },
  { type: "code", words: ["代码", "源码", "程序", "开源", "脚本"] },
  { type: "video", words: ["视频", "短片", "直播回放", "剪辑"] },
  { type: "image", words: ["图片", "插画", "设计稿", "照片", "海报", "漫画"] },
  { type: "nft", words: ["数字藏品", "NFT", "nft", "链上资产"] },
  { type: "text", words: ["文章", "小说", "文案", "书稿", "论文", "攻略"] },
];

/** 确权登记通道 —— 精简自 RightsResourceFreeList，仅保留可在 XAF 边界内引用的公开信息 */
const CHANNELS = [
  {
    name: "武汉数据交易所个人登记入口",
    type: "数据确权",
    url: "https://www.wuhandata.cn/",
    cost: "免费",
    turnaround: "审核5-15个工作日",
    prerequisite: "手机号+身份证实名注册",
    tags: ["personal_data", "dataset", "text"],
    priority: 1,
  },
  {
    name: "上海数据交易所数据资产登记",
    type: "数据资产化",
    url: "https://www.chinadex.com.cn/",
    cost: "基础登记免费",
    turnaround: "5-10个工作日",
    prerequisite: "实名+数据源证明材料",
    tags: ["dataset", "personal_data", "text"],
    priority: 2,
  },
  {
    name: "Marmot Data Governance",
    type: "AI训练数据授权",
    url: "https://marmotdata.com/",
    cost: "免费tier(个人创作者)",
    turnaround: "上传即生效",
    prerequisite: "英文界面，需数据使用权证明",
    tags: ["dataset", "text", "image", "video"],
    priority: 3,
  },
  {
    name: "walt.id 去中心化身份 + VC 签发",
    type: "DID签发",
    url: "https://walt.id/",
    cost: "开源免费",
    turnaround: "即刻签发",
    prerequisite: "需技术集成能力",
    tags: ["nft", "code", "creative_work"],
    priority: 4,
  },
];

/** 服务 SKU —— 直接沿用 get_services_catalog() 的价格锚点 */
const SERVICE_CATALOG = [
  {
    sku: "prepack-basic",
    name: "AI辅助版权登记预审包",
    price_cny: 29.9,
    target: "文字/图片/视频创作者",
    tags: ["text", "image", "video", "nft"],
    keywords: "版权登记 作品备案 确权 知识产权保护",
  },
  {
    sku: "prepack-submit",
    name: "数据资产确权代提交服务",
    price_cny: 99.0,
    target: "有数据变现需求的创作者",
    tags: ["dataset", "personal_data"],
    keywords: "数据资产 数据确权 AI训练授权 数据变现",
  },
  {
    sku: "prepack-license",
    name: "AI训练数据授权代理",
    price_cny: 49.9,
    target: "拥有大量文本/问答数据的用户",
    tags: ["dataset", "text", "code"],
    keywords: "AI训练数据 数据授权 ChatGPT训练 数据收益",
  },
];

const STAGE_OF = { HOT: "stage3", WARM: "stage2", COLD: "stage1", NONE: "stage1" };

function classifyAsset(content, override) {
  if (override && override !== "auto") return { type: override, source: "explicit" };
  const hits = [];
  for (const pattern of ASSET_PATTERNS) {
    const n = pattern.words.reduce((acc, w) => acc + (content.includes(w) ? 1 : 0), 0);
    if (n > 0) hits.push({ type: pattern.type, hits: n });
  }
  hits.sort((a, b) => b.hits - a.hits);
  return { type: hits[0]?.type ?? "unknown", source: hits[0] ? "inferred" : "default", candidates: hits.slice(0, 3) };
}

function scoreGroups(content) {
  const matched = [];
  let intentScore = 0;
  for (const [group, kws] of Object.entries(RIGHTS_KEYWORDS)) {
    for (const [kw, weight] of Object.entries(kws)) {
      if (content.includes(kw)) {
        matched.push({ keyword: kw, group, weight });
        intentScore += weight;
      }
    }
  }
  return { matched, intentScore: Number(intentScore.toFixed(3)) };
}

function detectPainPoints(content) {
  return Object.entries(RIGHTS_KEYWORDS.pain_points)
    .filter(([pain]) => content.includes(pain))
    .map(([pain, score]) => ({ pain, score }))
    .sort((a, b) => b.score - a.score);
}

function gradeOf(score) {
  if (score >= 1.5) return "HOT";
  if (score >= 0.8) return "WARM";
  if (score > 0) return "COLD";
  return "NONE";
}

/**
 * @param {{content:string, asset_type?:string, include_channels?:boolean}} input
 */
export function rightsPrecheck(input) {
  const content = String(input.content ?? "");
  const { matched, intentScore } = scoreGroups(content);
  const painPoints = detectPainPoints(content);
  const asset = classifyAsset(content, input.asset_type);
  const grade = gradeOf(intentScore);

  // 合规：禁用承诺词 + PII 脱敏（红线 C/D）
  const compliance = checkContentCompliance(content);

  let channels = [];
  if (input.include_channels !== false) {
    channels = CHANNELS.filter((c) => asset.type === "unknown" || c.tags.includes("creative_work") || c.tags.includes(asset.type))
      .sort((a, b) => a.priority - b.priority)
      .map(({ name, type, url, cost, turnaround, prerequisite }) => ({ name, type, url, cost, turnaround, prerequisite }));
  }

  const sku = SERVICE_CATALOG.find((s) => s.tags.includes(asset.type)) ?? SERVICE_CATALOG[0];

  const nextStep =
    grade === "HOT"
      ? "高意向：直接给方案+报价，进入成交引导（stage3），需双方确认服务范围后再收费"
      : grade === "WARM"
        ? "中意向：给分层方案对比，明确官方费用与服务费边界（stage2）"
        : grade === "COLD"
          ? "低意向：先做需求确认三问，判定资产类型与目的（stage1）"
          : "无确权信号：不推送确权话术，避免骚扰";

  return {
    tool: "rights_precheck",
    priority: grade,
    recommended_stage: STAGE_OF[grade],
    intent_score: intentScore,
    asset_class: asset.type,
    asset_class_source: asset.source,
    asset_class_candidates: asset.candidates ?? [],
    matched_keywords: matched,
    pain_points: painPoints,
    compliance: {
      passed: compliance.passed,
      violations: compliance.violations,
      pii_masked: compliance.pii_masked,
    },
    sanitized_excerpt: compliance.sanitized.slice(0, 300),
    recommended_service: { sku: sku.sku, name: sku.name, price_cny: sku.price_cny, target: sku.target },
    channels,
    next_step: nextStep,
    disclaimer:
      "预审结论由规则引擎给出，不构成法律意见；确权审核由官方登记机构进行，最终结果以机构审核为准。不得承诺通过率。",
  };
}
