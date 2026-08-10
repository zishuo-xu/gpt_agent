/** 展示层纯格式化函数（无依赖，各面板共用） */

export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  const seconds = ms / 1000;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 时`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)} 分`;
  if (ms >= 1000) return `${seconds.toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
