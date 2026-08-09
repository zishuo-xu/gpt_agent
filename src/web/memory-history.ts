import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const HISTORY_DIR = ".history";
const MAX_SNAPSHOTS_PER_DOC = 50;

/**
 * 记忆文件写时留档：agent 通过 Edit/MultiEdit/Write 修改记忆文件时，
 * 工具执行层（AtomicFileTools）在写入前调用 snapshot() 把旧内容留档到
 * 同目录 .history/，供记忆面板时间线展示「本次自动写入的前后 diff」。
 * 手动编辑（编辑器）不经过此路径——diff 语义与时间线数据源（工具事件）一致。
 * 文件名：<文档名>-<YYYYMMDD-HHmmss-SSS>.md，ts 前缀字典序即时间序。
 */
export class MemoryHistoryKeeper {
  readonly #memoryPaths: ReadonlySet<string>;

  constructor(memoryPaths: readonly string[]) {
    this.#memoryPaths = new Set(memoryPaths.map((p) => path.resolve(p)));
  }

  async snapshot(filePath: string, before: string | null): Promise<void> {
    if (before === null) return; // 新建文件：无旧内容可留
    const absolute = path.resolve(filePath);
    if (!this.#memoryPaths.has(absolute)) return;
    const dir = path.join(path.dirname(absolute), HISTORY_DIR);
    await mkdir(dir, { recursive: true });
    const base = path.basename(absolute, path.extname(absolute));
    const ts = formatTimestamp(new Date());
    // 随机后缀防同毫秒碰撞（密集写入不覆盖留档）；ts 前缀保持字典序 = 时间序
    const rand = randomUUID().slice(0, 4);
    await writeFile(
      path.join(dir, `${base}-${ts}-${rand}.md`),
      before,
      "utf8",
    );
    await trimToLimit(dir, base);
  }
}

/** YYYYMMDD-HHmmss-SSS（本地时间，前缀字典序 = 时间序） */
function formatTimestamp(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

/** 每文档最多保留 MAX_SNAPSHOTS_PER_DOC 份，超限删除最旧（文件名 ts 前缀排序） */
async function trimToLimit(dir: string, base: string): Promise<void> {
  const files = (await readdir(dir))
    .filter((file) => file.startsWith(`${base}-`) && file.endsWith(".md"))
    .sort();
  const excess = files.length - MAX_SNAPSHOTS_PER_DOC;
  if (excess <= 0) return;
  for (const file of files.slice(0, excess)) {
    await unlink(path.join(dir, file));
  }
}
