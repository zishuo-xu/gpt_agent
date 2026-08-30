import type { AgentEvent } from "./types.js";

interface Pending {
  resolve: (answer: string | undefined) => void;
}

/** 任务内关键澄清等待器：无超时默认，不替用户做决定。 */
export class ClarificationWaiter {
  readonly #setStatus: (status: "running" | "waiting_user") => void;
  readonly #pending = new Map<string, Pending>();
  constructor(options: {
    setStatus: (status: "running" | "waiting_user") => void;
  }) {
    this.#setStatus = options.setStatus;
  }

  async wait(
    interaction: Extract<AgentEvent, { type: "need_user" }>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const id = interaction.questionId;
    if (!id) return undefined;
    this.#setStatus("waiting_user");
    return await new Promise((resolve) => {
      const onAbort = () => finish(undefined);
      const finish = (answer: string | undefined) => {
        signal.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
        if (answer !== undefined) this.#setStatus("running");
        resolve(answer);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, { resolve: finish });
    });
  }
  resolve(questionId: string, answer: string): boolean {
    const pending = this.#pending.get(questionId);
    if (!pending || !answer.trim()) return false;
    pending.resolve(answer.trim());
    return true;
  }

  cancelAll(): void {
    for (const pending of [...this.#pending.values()]) {
      pending.resolve(undefined);
    }
  }
}
