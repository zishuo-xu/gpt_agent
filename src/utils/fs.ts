import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

/** ENOENT 容错读：文件不存在返回 null（原样区分「存在但为空」与「不存在」） */
export async function readOptional(
  filePath: string,
): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface ReadJsonlResult<T> {
  records: T[];
  /** 被跳过的坏行数（追加写中断残留半行、手动编辑损坏等） */
  skipped: number;
}

/**
 * 容错读取 JSONL：逐行 parse，坏行跳过（不抛错）。
 * 事件流是追加写，进程崩溃可能留下半行——坏一行不能毁掉整个会话历史。
 */
export async function readJsonl<T>(filePath: string): Promise<ReadJsonlResult<T>> {
  const content = await readFile(filePath, "utf8");
  let skipped = 0;
  const records: T[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

export interface AtomicWriteOptions {
  /** 新文件权限位（默认 0o600） */
  mode?: number;
  signal?: AbortSignal;
}

/**
 * 原子写：同目录临时文件 + fsync + rename。
 * 目标已存在时保留原权限位；信号中止时不落盘（临时文件清理）。
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      const original = await stat(filePath);
      await chmod(tempPath, original.mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (options.signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
