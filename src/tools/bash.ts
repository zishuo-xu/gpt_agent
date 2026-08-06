import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolExecutionResult } from "../core/types.js";
import { TOOL_OUTPUT_LIMITS, truncateToolText } from "./truncate.js";

export interface BashOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  background?: boolean;
}

/**
 * 主进程退出后等待输出流排空的兜底时长（毫秒）。
 * 参照 Pi 的 exec.ts：后台孙进程（如 `sleep 100 &`）若继承 stdout/stderr 句柄，
 * 管道永远不关闭，依赖 close 事件会让命令“永不结束”。
 * 因此以 exit 为准、给输出排空一个上限，超时则接受可能不完整的输出。
 * 定时器在收到 data 时续期（见 onExit），持续输出的孙进程不会被误截断。
 */
const OUTPUT_DRAIN_TIMEOUT_MS = 2_000;

/** 全量输出落盘序号（进程内自增，配合 pid 保证文件唯一） */
let spillSequence = 0;

/**
 * 清理过期超限落盘日志（myagent-bash-*.log）：启动时调用，删除 mtime 超过
 * retentionDays 的临时产物，防止长期运行的守护进程在 tmp 下累积磁盘占用。
 * 失败静默（tmp 清理属尽力而为）。
 */
export async function cleanupStaleBashLogs(
  retentionDays = 7,
  tmpDir = os.tmpdir(),
): Promise<void> {
  try {
    const { readdir, stat, unlink } = await import("node:fs/promises");
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    const entries = await readdir(tmpDir);
    await Promise.all(
      entries
        .filter((name) => name.startsWith("myagent-bash-"))
        .map(async (name) => {
          try {
            const info = await stat(path.join(tmpDir, name));
            if (info.mtimeMs < cutoff) {
              await unlink(path.join(tmpDir, name));
            }
          } catch {
            // 单个文件竞争删除失败不影响其余
          }
        }),
    );
  } catch {
    // tmp 目录不可读等异常：静默
  }
}

/**
 * 输出超限时把全量 stdout/stderr 落盘（参照 Pi 的 /tmp/pi-bash-*.log）：
 * 模型只见截断版，需要全量时按 summary 里的路径用 Read 查看。
 * 未截断返回 undefined，避免无谓写盘。
 */
async function spillFullOutput(
  stdout: string,
  stderr: string,
): Promise<string | undefined> {
  if (!stdout && !stderr) return undefined;
  const filePath = path.join(
    os.tmpdir(),
    `myagent-bash-${process.pid}-${spillSequence}.log`,
  );
  spillSequence += 1;
  await writeFile(
    filePath,
    `── stdout ──\n${stdout}\n── stderr ──\n${stderr}\n`,
    "utf8",
  );
  return filePath;
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

export async function runBash(
  command: string,
  options: BashOptions,
): Promise<ToolExecutionResult> {
  if (options.signal?.aborted) {
    throw abortError();
  }
  const startedAt = Date.now();

  // 后台执行：启动 detached 进程立即返回，不阻塞主循环；输出不采集
  if (options.background) {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid ?? 0;
    return {
      summary: `命令已在后台启动（pid ${pid}）`,
      output: {
        background: true,
        pid,
        hint: "后台进程不阻塞当前循环；如需查看状态或输出请另行运行 ps / 日志命令。",
      },
      aborted: false,
      isError: false,
      details: { command, background: true, pid },
    };
  }

  return await new Promise<ToolExecutionResult>((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    /**
     * 统一出口：截断时把全量输出落盘并把路径带进 summary/details。
     * 异步写盘不阻塞采集流程（resolve 前 await 保证结果与文件一致）。
     */
    const emitResult = async (result: ToolExecutionResult): Promise<void> => {
      const details = result.details as
        | { truncated?: boolean }
        | undefined;
      if (details?.truncated) {
        const fullPath = await spillFullOutput(stdout, stderr);
        if (fullPath) {
          result.details = {
            ...(result.details as Record<string, unknown>),
            fullOutputPath: fullPath,
          };
          result.summary = `${result.summary}，完整输出：${fullPath}`;
        }
      }
      resolve(result);
    };

    // 先 kill 子进程树（整组 SIGTERM，500ms 后未退出再 SIGKILL），
    // 再返回已收集的部分输出，避免超时/abort 后残留孤儿进程（参照 Pi：aborted 结果可取回）
    const killChildTree = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    /** 中止/超时共用：kill 进程树后以部分输出 resolve，而不是丢弃已采集的 stdout/stderr */
    const terminateAndResolve = (reason: "abort" | "timeout"): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", onAbort);
      killChildTree("SIGTERM");
      const forceTimer = setTimeout(() => killChildTree("SIGKILL"), 500);
      forceTimer.unref();
      const boundedStdout = truncateToolText(stdout, {
        ...TOOL_OUTPUT_LIMITS.bash,
        preferTail: true,
        continuationHint: "rerun a narrower command to recover omitted output",
      });
      const boundedStderr = truncateToolText(stderr, {
        ...TOOL_OUTPUT_LIMITS.bash,
        preferTail: true,
        continuationHint: "rerun a narrower command to recover omitted output",
      });
      void emitResult({
        summary:
          reason === "abort"
            ? `命令被中止（用户中断），已终止进程并保留部分输出${boundedStdout.truncated || boundedStderr.truncated ? "（输出已截断）" : ""}`
            : `命令超时（${options.timeoutMs}ms），已终止进程并保留部分输出${boundedStdout.truncated || boundedStderr.truncated ? "（输出已截断）" : ""}`,
        output: {
          stdout: boundedStdout.text,
          stderr: boundedStderr.text,
          code: null,
          signal: "SIGTERM",
        },
        traceOutput: { stdout, stderr, code: null, signal: "SIGTERM" },
        aborted: reason === "abort",
        isError: true,
        details: {
          command,
          durationMs: Date.now() - startedAt,
          code: null,
          signal: "SIGTERM",
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          truncated: boundedStdout.truncated || boundedStderr.truncated,
          outputIncomplete: true,
          ...(reason === "timeout" ? { timedOut: true } : {}),
        },
      });
    };
    const onAbort = (): void => terminateAndResolve("abort");

    const timeout = options.timeoutMs
      ? setTimeout(() => terminateAndResolve("timeout"), options.timeoutMs)
      : undefined;
    timeout?.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null | undefined,
      outputIncomplete: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", onAbort);
      const boundedStdout = truncateToolText(stdout, {
        ...TOOL_OUTPUT_LIMITS.bash,
        preferTail: true,
        continuationHint: "rerun a narrower command to recover omitted output",
      });
      const boundedStderr = truncateToolText(stderr, {
        ...TOOL_OUTPUT_LIMITS.bash,
        preferTail: true,
        continuationHint: "rerun a narrower command to recover omitted output",
      });
      const truncated =
        boundedStdout.truncated || boundedStderr.truncated;
      void emitResult({
        summary: `命令退出：${code ?? signal ?? "unknown"}${
          outputIncomplete ? "（输出可能不完整：仍有子进程在后台运行）" : ""
        }${truncated ? "（输出已截断）" : ""}`,
        output: {
          stdout: boundedStdout.text,
          stderr: boundedStderr.text,
          code,
          signal,
        },
        traceOutput: { stdout, stderr, code, signal },
        aborted: false,
        isError: typeof code === "number" && code !== 0,
        details: {
          command,
          durationMs: Date.now() - startedAt,
          code,
          signal,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          truncated,
          outputIncomplete,
        },
      });
    };

    // 以主进程退出为准（不依赖 close：孙进程持有 pipe 句柄时 close 永不触发）；
    // 退出后等待输出流排空，最多 OUTPUT_DRAIN_TIMEOUT_MS，超时接受不完整输出。
    // 排空定时器随每次 data 续期（参照 Pi waitForChildProcess 的 EXIT_STDIO_GRACE_MS）：
    // 孙进程持续输出时继续收集不截断；静默持有句柄的后代在空闲超时后放行。
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      const streams = [child.stdout, child.stderr].filter(
        (stream): stream is NonNullable<typeof child.stdout> =>
          stream !== null && stream !== undefined,
      );
      if (streams.length === 0 || streams.every((stream) => stream.readableEnded)) {
        finish(code, signal, false);
        return;
      }
      let remaining = streams.length;
      const onEnd = (): void => {
        remaining -= 1;
        if (remaining === 0) {
          if (drainTimer) clearTimeout(drainTimer);
          finish(code, signal, false);
        }
      };
      for (const stream of streams) {
        stream.once("end", onEnd);
      }
      const armDrain = (): void => {
        if (settled) return;
        if (drainTimer) clearTimeout(drainTimer);
        drainTimer = setTimeout(() => {
          finish(code, signal, true);
        }, OUTPUT_DRAIN_TIMEOUT_MS);
        drainTimer.unref();
      };
      armDrain();
      for (const stream of streams) {
        stream.on("data", armDrain);
      }
    };
    child.once("exit", onExit);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}
