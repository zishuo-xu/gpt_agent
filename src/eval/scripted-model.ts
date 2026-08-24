import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import type { ScriptedStep } from "./types.js";

/** Deterministic provider used by evals. It never performs network I/O. */
export class ScriptedModelClient implements ModelClient {
  readonly requests: CompletionRequest[] = [];
  readonly steps: ScriptedStep[];
  #cursor = 0;

  constructor(steps: ScriptedStep[]) {
    this.steps = [...steps];
  }

  async complete(request: CompletionRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const step = this.steps[this.#cursor++] ?? { kind: "respond", text: "done" };
    if (step.kind === "throw") throw step.error;
    const toolCalls = step.action
      ? [{ id: `script-${this.#cursor}`, ...step.action }]
      : [];
    return {
      text: step.text ?? (step.action ? "" : "done"),
      toolCalls,
      usage: { input: 100, output: step.action ? 20 : 10, cached: 0 },
      providerId: "scripted",
      model: "scripted-eval",
    };
  }
}

export function action(tool: string, target: string, args: unknown): ScriptedStep {
  return { kind: "respond", action: { tool, target, args } };
}
