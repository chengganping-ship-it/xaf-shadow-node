/**
 * Tool 目录 —— MCP tools/list 的唯一事实源，同时驱动 Stage X4 的 RSI 商业变异（改写这里 = 变异靶点）。
 *
 * 每个 tool 自带 JSON Schema（draft-07 子集），由 src/validate.js 做轻量校验，零第三方依赖。
 */

export const TOOL_DEFS = [
  {
    name: "rights_precheck",
    title: "数字资产确权预审",
    description:
      "对一段内容/资产描述做确权预审：识别资产类别、确权意图强度、痛点信号、推荐登记通道与所需前置材料，并强制执行合规红线（禁用违规承诺词、自动脱敏个人敏感信息）。返回可执行的分级处置建议与预估服务报价。",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "待预审的内容文本、作品描述或用户咨询原文（≤4000 字）",
          maxLength: 4000,
        },
        asset_type: {
          type: "string",
          description: "资产类型，可选：text|image|video|code|dataset|nft|personal_data",
          enum: ["text", "image", "video", "code", "dataset", "nft", "personal_data", "auto"],
        },
        include_channels: {
          type: "boolean",
          description: "是否返回推荐的确权登记通道清单，默认 true",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "c2c_lead_sniff",
    title: "C2C 确权线索嗅探",
    description:
      "对一批 C2C 平台消息/帖子做线索嗅探：按五组关键词（确权核心/侵权维权/平台特征/资产类别/变现信号）+ 负向排除打分，识别来源平台、意图优先级，并匹配最合适的服务 SKU 与应答阶段。适合挂在闲鱼/小红书/Fiverr 监听 pipeline 上做批量前置过滤。",
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          description: "待嗅探的消息列表，1~50 条",
          items: { type: "string", maxLength: 2000 },
          minItems: 1,
          maxItems: 50,
        },
        text: { type: "string", description: "单条文本快捷入口（与 messages 二选一）", maxLength: 2000 },
        threshold: {
          type: "number",
          description: "命中阈值，默认 0.6；低于阈值不进入 HOT/WARM 分级",
          minimum: 0,
          maximum: 1,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "portfolio_valuation",
    title: "数字资产组合估值",
    description:
      "对一组数字资产（互动语料、话术模板、合规知识库、数据集、作品）做组合估值：按资产类别基准价 × 质量系数 × 授权模式系数估算 CNY/USD 区间与期望值，输出组合总额、集中度风险与推荐变现顺序。估值仅供商业判断，不承诺任何收益。",
    inputSchema: {
      type: "object",
      properties: {
        assets: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          description: "资产清单",
          items: {
            type: "object",
            properties: {
              name: { type: "string", maxLength: 120 },
              type: {
                type: "string",
                enum: ["interaction_logs", "templates", "compliance_kb", "dataset", "creative_work"],
              },
              volume_units: { type: "number", minimum: 0, description: "体量：条数/套数/MB（视 type 而定）" },
              quality: { type: "number", minimum: 0, maximum: 1, description: "质量分 0~1，缺省 0.6" },
              license_model: {
                type: "string",
                enum: ["per_unit", "one_time", "subscription"],
                description: "授权模式，缺省 one_time",
              },
              anonymized: { type: "boolean", description: "是否已脱敏；未脱敏会扣减合规准备成本" },
            },
            required: ["name", "type"],
            additionalProperties: false,
          },
        },
        horizon_years: { type: "number", minimum: 1, maximum: 5, description: "估值周期（年），缺省 1" },
      },
      required: ["assets"],
      additionalProperties: false,
    },
  },
];

export const TOOL_MAP = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, t]));

export function listTools() {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", ...t.inputSchema },
  }));
}
