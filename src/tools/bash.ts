import { spawn } from "node:child_process";
import type { ToolExecutionResult } from "../core/types.js";
import { truncateToolText } from "./truncate.js";

export interface BashOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  background?: boolean;
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

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", terminateAndReject);
      reject(error);
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", terminateAndReject);
      const boundedStdout = truncateToolText(stdout, {
        continuationHint: "rerun a narrower command to recover omitted output",
      });
      const boundedStderr = truncateToolText(stderr, {
        continuationHint: "rerun a narrower command to recover omitted output",
      });
      resolve({
        summary: `命令退出：${code ?? signal ?? "unknown"}${
          boundedStdout.truncated || boundedStderr.truncated
            ? "（输出已截断）"
            : ""
        }`,
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
    });
  });
}
