/**
 * 类型化错误体系 —— 客户端永远只看到 {error:{code,message,data}}，不泄漏堆栈。
 */

export const ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // 未知 tool 归入 JSON-RPC 标准「无效参数」（-32602），避免自定义码让客户端兼容层掉坑
  TOOL_NOT_FOUND: -32602,
  TOOL_EXECUTION_FAILED: -32002,
  PAYMENT_REQUIRED: -32003,
  SAFETY_VIOLATION: -32004,
});

const HTTP_STATUS = {
  PARSE_ERROR: 400,
  INVALID_REQUEST: 400,
  METHOD_NOT_FOUND: 404,
  INVALID_PARAMS: 422,
  INTERNAL_ERROR: 500,
  TOOL_NOT_FOUND: 422,
  TOOL_EXECUTION_FAILED: 500,
  PAYMENT_REQUIRED: 402,
  SAFETY_VIOLATION: 403,
};

/** 业务错误基类。 httpStatus 决定 HTTP 层状态码，code 决定 JSON-RPC 层错误码。 */
export class AppError extends Error {
  constructor(key, message, data) {
    super(message);
    this.name = "AppError";
    this.key = key;
    this.code = ERROR_CODES[key] ?? ERROR_CODES.INTERNAL_ERROR;
    this.httpStatus = HTTP_STATUS[key] ?? 500;
    this.data = data;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      data: this.data ?? { error_key: this.key },
    };
  }
}

export const badRequest = (m, d) => new AppError("INVALID_REQUEST", m, d);
export const invalidParams = (m, d) => new AppError("INVALID_PARAMS", m, d);
export const notFound = (m, d) => new AppError("METHOD_NOT_FOUND", m, d);
export const paymentRequired = (m, d) => new AppError("PAYMENT_REQUIRED", m, d);
export const safetyViolation = (m, d) => new AppError("SAFETY_VIOLATION", m, d);
export const toolNotFound = (m, d) => new AppError("TOOL_NOT_FOUND", m, d);
