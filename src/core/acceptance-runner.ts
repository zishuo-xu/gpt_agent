import { runBash } from "../tools/bash.js";

export interface AcceptanceCheckResult {
  command: string;
  status: "passed" | "failed" | "timed_out";
  exitCode?: number;
  durationMs: number;
  output: string;
}

export async function runAcceptanceChecks(input: {
  cwd: string;
  checks: string[];
  timeoutMs: number;
  remainingMs?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}): Promise<AcceptanceCheckResult[]> {
  const results: AcceptanceCheckResult[] = [];
  for (const command of input.checks) {
    const started = Date.now();
    const remaining = input.deadlineAt === undefined
      ? input.remainingMs
      : input.deadlineAt - Date.now();
    if (remaining !== undefined && remaining <= 0) {
      results.push({ command, status: "timed_out", durationMs: 0, output: "验收截止时间已到" });
      continue;
    }
    const timeout = remaining === undefined ? input.timeoutMs : Math.min(input.timeoutMs, remaining);
    const result = await runBash(command, {
      cwd: input.cwd,
      timeoutMs: timeout,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const details = (result.details ?? {}) as { code?: number | null; timedOut?: boolean; signal?: string | null };
    const timedOut = details.timedOut === true || /命令超时/.test(result.summary);
    const output = typeof result.output === "string"
      ? result.output
      : result.output && typeof result.output === "object"
        ? JSON.stringify(result.output)
        : result.summary;
    results.push({
      command,
      status: timedOut ? "timed_out" : result.isError ? "failed" : "passed",
      ...(typeof details.code === "number" ? { exitCode: details.code } : {}),
      durationMs: Date.now() - started,
      output: output.slice(0, 12_000),
    });
  }
  return results;
}
