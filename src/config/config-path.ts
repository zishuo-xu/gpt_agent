/**
 * Schema 字段键读写工具（CLI /config 与 Web 设置页共用）：
 * 字段键可能是 dotted（server.host、behavior.showCacheMissNotices）或平铺
 * （providers、models），支持任意深度。设置页 generatedFields 对两类键必须
 * 读写一致，否则 dotted 键会被当成顶层扁平键，保存时被后端 mergeSecrets 静默丢弃。
 */

export function getConfigValue(
  config: Record<string, unknown>,
  key: string,
): unknown {
  let current: unknown = config;
  for (const segment of key.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setConfigValue<T extends Record<string, unknown>>(
  config: T,
  key: string,
  value: unknown,
): T {
  const segments = key.split(".");
  const head = segments[0]!;
  if (segments.length === 1) {
    return { ...config, [head]: value } as T;
  }
  const section = config[head];
  const base =
    section && typeof section === "object"
      ? (section as Record<string, unknown>)
      : {};
  return {
    ...config,
    [head]: setConfigValue(base, segments.slice(1).join("."), value),
  } as T;
}
