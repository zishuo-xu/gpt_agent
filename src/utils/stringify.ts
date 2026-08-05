/** 工具输出/未知值序列化：字符串原样返回，其余 JSON 化（失败兜底 String） */
export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
