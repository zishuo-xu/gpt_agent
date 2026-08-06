/**
 * 启动计时（参照 Pi 的 PI_TIMING=1）：MYAGENT_TIMING=1 时输出各阶段耗时，
 * 用于诊断守护进程启动慢、restore 瓶颈等。开关判定在读取时进行，
 * 未开启时标记操作零成本（一次环境变量读）。
 */

const marks: Array<{ name: string; ms: number }> = [];
let last = performance.now();

/** 记录一个阶段耗时（相对上一个标记点）；未开启时无操作 */
export function timingMark(name: string): void {
  if (process.env.MYAGENT_TIMING !== "1") return;
  const now = performance.now();
  marks.push({ name, ms: now - last });
  last = now;
}

/** 启动完成时输出完整计时报告；未开启时返回空串 */
export function timingReport(): string {
  if (process.env.MYAGENT_TIMING !== "1" || marks.length === 0) return "";
  const total = marks.reduce((sum, mark) => sum + mark.ms, 0);
  const lines = marks.map(
    (mark) => `  ${mark.name}: ${mark.ms.toFixed(0)}ms`,
  );
  return `\n[timing] 启动总耗时 ${total.toFixed(0)}ms\n${lines.join("\n")}\n`;
}
