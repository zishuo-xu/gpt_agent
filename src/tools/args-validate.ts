import { Ajv } from "ajv";
import type { ToolCall } from "../core/types.js";
import { CODING_TOOL_DEFINITIONS } from "../model/tool-definitions.js";

/**
 * Schema 单层参数校验（参照 Pi validation.ts：AJV 编译缓存 + 类型强转 + 字段级报错）。
 * 参数全程 wire 键名（file_path 等，无 camelCase 转换层）：
 * - 强转：`coerceTypes: true` 按 type 声明把 string 数字转 number（模型常发 "5000"）；
 * - 校验：required / minLength / minItems / 嵌套结构按 inputSchema 精确检查；
 * - 报错：定位到 instancePath（+ missingProperty / additionalProperty 字段名），
 *   并回显收到的完整参数，模型能看出自己发错的键。
 */
const ajv = new Ajv({ coerceTypes: true, allErrors: false, strict: false });
const validators = new Map<string, ReturnType<Ajv["compile"]>>();

function validatorFor(tool: string): ReturnType<Ajv["compile"]> | undefined {
  let validator = validators.get(tool);
  if (validator) return validator;
  const definition = CODING_TOOL_DEFINITIONS.find(
    (item) => item.name === tool,
  );
  if (!definition) return undefined;
  validator = ajv.compile(definition.inputSchema as Record<string, unknown>);
  validators.set(tool, validator);
  return validator;
}

export function validateToolArgs(
  call: ToolCall,
): { args?: unknown; error?: string } {
  const validator = validatorFor(call.tool);
  // 未知工具（未注册 schema）兜底放行，不拦截执行
  if (!validator) return { args: call.args };
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (validator(args)) return { args };
  const error = validator.errors?.[0];
  // required 缺失字段名在 params.missingProperty，additionalProperties 在 additionalProperty，
  // 两者都拼进 instancePath 精确定位
  const params = error?.params as
    | { additionalProperty?: string; missingProperty?: string }
    | undefined;
  const field = params?.additionalProperty ?? params?.missingProperty;
  const fieldPath = field
    ? `${error?.instancePath ?? ""}/${field}`
    : error?.instancePath || "/";
  const message = error?.message ?? "参数不符合 schema";
  return {
    error: `参数错误：${call.tool} ${fieldPath}: ${message}。收到：${JSON.stringify(call.args).slice(0, 300)}`,
  };
}
