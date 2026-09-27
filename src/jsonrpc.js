/**
 * JSON-RPC 2.0 层 —— 无状态（MCP 2026-07-28 stateless 口径），零第三方依赖。
 * 负责：解析 → 校验 → 分派 → 错误信封。不含业务逻辑。
 */

import { AppError, toolNotFound } from "./errors.js";
import { TOOL_MAP, listTools } from "./catalog.js";
import { rightsPrecheck } from "./core/rights.js";
import { c2cLeadSniff } from "./core/leads.js";
import { portfolioValuation } from "./core/valuation.js";

const TOOL_IMPLS = {
  rights_precheck: rightsPrecheck,
  c2c_lead_sniff: c2cLeadSniff,
  portfolio_valuation: portfolioValuation,
};

/** draft-07 子集校验器：required / type / enum / min~max / string maxLength / array bounds / additionalProperties */
function validate(schema, value, path = "", out = []) {
  if (!schema || typeof schema !== "object") return out;

  for (const key of schema.required ?? []) {
    if (value?.[key] === undefined) out.push(`${path || "$"}.${key} is required`);
  }
  if (value === undefined || value === null) return out;

  const t = schema.type;
  if (t === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      out.push(`${path || "$"} expected object`);
      return out;
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const k of Object.keys(value)) if (!allowed.has(k)) out.push(`${path || "$"}.${k} is not allowed`);
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (value[k] !== undefined) validate(sub, value[k], `${path || "$"}.${k}`, out);
    }
  } else if (t === "array") {
    if (!Array.isArray(value)) {
      out.push(`${path || "$"} expected array`);
      return out;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${path || "$"} minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path || "$"} maxItems ${schema.maxItems}`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path || "$"}[${i}]`, out));
  } else if (t === "string") {
    if (typeof value !== "string") out.push(`${path || "$"} expected string`);
    else if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path || "$"} maxLength ${schema.maxLength}`);
  } else if (t === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) out.push(`${path || "$"} expected number`);
    else {
      if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path || "$"} minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path || "$"} maximum ${schema.maximum}`);
    }
  } else if (t === "boolean" && typeof value !== "boolean") {
    out.push(`${path || "$"} expected boolean`);
  }

  if (schema.enum && !schema.enum.includes(value)) out.push(`${path || "$"} not in enum`);
  return out;
}

function ok(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function fail(id, err) {
  const e = err instanceof AppError ? err.toJSON() : { code: -32603, message: String(err?.message ?? err) };
  return { jsonrpc: "2.0", id: id ?? null, error: e };
}

/** 执行单个 tool（被 x402 门禁放行之后调用） */
export function executeTool(name, args) {
  const impl = TOOL_IMPLS[name];
  const def = TOOL_MAP[name];
  if (!impl || !def) throw toolNotFound(`未知工具: ${name}`, { name, known: Object.keys(TOOL_IMPLS) });

  const errors = validate(def.inputSchema, args ?? {});
  if (errors.length) {
    throw new AppError("INVALID_PARAMS", `参数校验失败: ${errors.join("; ")}`, { errors, tool: name });
  }
  return impl(args ?? {});
}

/**
 * 处理一条 JSON-RPC 请求。
 * @returns {{status:number, body:object|null}}
 */
export function handleRpc(req, ctx) {
  const { method, id, params } = req;
  const isNotification = !("id" in req) || id === undefined;

  switch (method) {
    case "ping":
      return { status: 200, body: ok(id, {}) };

    case "initialize":
      return {
        status: 200,
        body: ok(id, {
          protocolVersion: ctx.protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            streaming: false,
            sessionless: true,
          },
          serverInfo: { name: "xaf-shadow-node", version: ctx.toolsetVersion },
          instructions:
            "XAF 匿名 MCP 影子节点。三条 Tool 均采用无状态调用；结算网络限定测试网（base-sepolia / polygon-amoy）。",
        }),
      };

    case "notifications/initialized":
    case "notifications/cancelled":
      return { status: 202, body: null };

    case "tools/list":
      return { status: 200, body: ok(id, { tools: listTools() }) };

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (typeof name !== "string" || !name) {
        return { status: 400, body: fail(id, new AppError("INVALID_PARAMS", "tools/call 缺少 name", {})) };
      }
      const result = executeTool(name, args);
      return {
        status: 200,
        body: ok(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        }),
      };
    }

    default:
      if (isNotification) return { status: 202, body: null };
      return {
        status: 404,
        body: fail(id, new AppError("METHOD_NOT_FOUND", `不支持的方法: ${method}`, { method })),
      };
  }
}

export function parseRpcPayload(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  } catch (e) {
    return { parseError: String(e?.message ?? e) };
  }
}

export { ok as rpcOk, fail as rpcFail };
