import { spawn } from "node:child_process";
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
 */
const OUTPUT_DRAIN_TIMEOUT_MS = 2_000;

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

    // 先 kill 子进程树（整组 SIGTERM，500ms 后未退出再 SIGKILL），
    // 再拒绝 Promise，避免超时/abort 后残留孤儿进程。
    const killChildTree = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const terminateAndReject = (): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", terminateAndReject);
      killChildTree("SIGTERM");
      const forceTimer = setTimeout(() => killChildTree("SIGKILL"), 500);
      forceTimer.unref();
      reject(abortError());
    };

    const timeout = options.timeoutMs
      ? setTimeout(terminateAndReject, options.timeoutMs)
      : undefined;
    timeout?.unref();
    options.signal?.addEventListener("abort", terminateAndReject, { once: true });

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null | undefined,
      outputIncomplete: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", terminateAndReject);
      const boundedStdout = truncateToolText(stdout, {
        ...TOOL_OUTPUT_LIMITS.bash,
        continuationHint: "rerun a narrower command to recover omitted output",
      });
      const boundedStderr = truncateToolText(stderr, {
        ...TOOL_OUTPUT_LIMITS.bash,
        continuationHint: "rerun a narrower command to recover omitted output",
      });
      const truncated =
        boundedStdout.truncated || boundedStderr.truncated;
      resolve({
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
      });
    };

    // 以主进程退出为准（不依赖 close：孙进程持有 pipe 句柄时 close 永不触发）；
    // 退出后等待输出流排空，最多 OUTPUT_DRAIN_TIMEOUT_MS，超时接受不完整输出。
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
      drainTimer = setTimeout(() => {
        finish(code, signal, true);
      }, OUTPUT_DRAIN_TIMEOUT_MS);
      drainTimer.unref();
    };
    child.once("exit", onExit);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", terminateAndReject);
      reject(error);
    });
  });
}
