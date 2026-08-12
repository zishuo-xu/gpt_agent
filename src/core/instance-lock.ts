import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

/** 项目级单实例写锁：O_EXCL 独占创建 + pid 记录；崩溃残留（持有者已死）自动接管 */
export async function acquireInstanceLock(
  lockPath: string,
  skip: boolean,
): Promise<void> {
  if (skip) return;
  try {
    await mkdir(path.dirname(lockPath), { recursive: true });
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    // 锁已存在：读取持有者 pid 做存活检测；持有者已死（崩溃残留）则删旧锁重试一次
    let holderPid: number | undefined;
    try {
      const raw = await readFile(lockPath, "utf8");
      holderPid = (JSON.parse(raw) as { pid?: number }).pid;
    } catch {
      // 锁内容不可读（半写坏锁）：按残留处理，同样删锁重试
    }
    // 持有者已死（崩溃残留）或锁内容不可读（半写坏锁）：删旧锁重试一次
    if (holderPid === undefined || !isPidAlive(holderPid)) {
      await unlink(lockPath).catch(() => undefined);
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(
            JSON.stringify({
              pid: process.pid,
              startedAt: new Date().toISOString(),
            }),
          );
        } finally {
          await handle.close();
        }
        return; // 接管成功
      } catch {
        // 重试仍失败（并发竞争）→ 落到下方统一报错
      }
    }
    const holder = holderPid === undefined ? "" : `（pid ${holderPid}）`;
    throw new Error(
      `项目已被其他进程占用${holder}：事件流为追加写，多进程并发会损坏数据。` +
        `若确认该进程已退出（崩溃残留），删除 ${lockPath} 后重试，或加 --force 忽略。`,
    );
  }
}

/** pid 存活检测：kill(pid, 0) 成功=存活；ESRCH=已死；EPERM=存在但无权限（视为存活，fail-closed） */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    return errno === "EPERM";
  }
}
