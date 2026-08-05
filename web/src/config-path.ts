/**
 * Schema 字段键读写工具：字段键可能是 dotted（server.host、behavior.showCacheMissNotices）
 * 或平铺（providers、models）。设置页 generatedFields 对两类键必须读写一致，
 * 否则 dotted 键会被当成顶层扁平键，保存时被后端 mergeSecrets 静默丢弃。
 */

export function getConfigValue(
  config: Record<string, unknown>,
  key: string,
): unknown {
  const segments = key.split(".");
  if (segments.length !== 2) return config[key];
  const section = config[segments[0]!];
  if (!section || typeof section !== "object") return undefined;
  return (section as Record<string, unknown>)[segments[1]!];
}

export function setConfigValue<T extends Record<string, unknown>>(
  config: T,
  key: string,
  value: unknown,
): T {
  const segments = key.split(".");
  if (segments.length !== 2) {
    return { ...config, [key]: value } as T;
  }
  const section = config[segments[0]!];
  const base =
    section && typeof section === "object"
      ? (section as Record<string, unknown>)
      : {};
  return {
    ...config,
    [segments[0]!]: { ...base, [segments[1]!]: value },
  } as T;
}
