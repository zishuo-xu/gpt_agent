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
  signal?: AbortSignal;
}): Promise<AcceptanceCheckResult[]> {
  const results: AcceptanceCheckResult[] = [];
  for (const command of input.checks) {
    const started = Date.now();
    const timeout = input.remainingMs === undefined
      ? input.timeoutMs
      : Math.max(1, Math.min(input.timeoutMs, input.remainingMs));
    const result = await runBash(command, {
      cwd: input.cwd,
      timeoutMs: timeout,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const details = (result.details ?? {}) as { code?: number | null; timedOut?: boolean };
    const output = typeof result.output === "string"
      ? result.output
      : result.output && typeof result.output === "object"
        ? JSON.stringify(result.output)
        : result.summary;
    results.push({
      command,
      status: details.timedOut ? "timed_out" : result.isError ? "failed" : "passed",
      ...(typeof details.code === "number" ? { exitCode: details.code } : {}),
      durationMs: Date.now() - started,
      output: output.slice(0, 12_000),
    });
  }
  return results;
}
