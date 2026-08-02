import type { AgentEvent } from "./types.js";

/**
 * 外部 webhook 推送器。
 *
 * 订阅会话事件流，把"需要用户知道"的事件推送到配置的 webhook：
 * - 任务完成（done）
 * - 任务出错（error / notify.error）
 * - 审批超时（notify.warn，由会话在超时拒绝时发出）
 *
 * 推送纪律（与设计文档一致）：只推需要知道的，不推主动汇报；
 * 同一会话每小时最多 2 条，超限丢弃。
 *
 * 格式自动适配：
 * - 企业微信机器人（qyapi.weixin.qq.com）→ { msgtype: "text", text: { content } }
 * - Bark（day.app）→ { title, body }
 * - 其他网关 → { title, body }（通用 JSON POST）
 */

const PUSH_PER_HOUR = 2;
const RATE_WINDOW_MS = 60 * 60 * 1000;

interface RateWindow {
  start: number;
  count: number;
}

export class WebhookNotifier {
  readonly #webhookUrl: string | undefined;
  readonly #sessionTitle: string;
  readonly #unsubscribe: () => void;
  #rateWindow: RateWindow = { start: Date.now(), count: 0 };

  constructor(
    subscribe: (listener: (event: AgentEvent) => void) => () => void,
    options: { webhookUrl?: string; sessionTitle: string },
  ) {
    this.#webhookUrl = options.webhookUrl?.trim() || undefined;
    this.#sessionTitle = options.sessionTitle;
    this.#unsubscribe = this.#webhookUrl
      ? subscribe((event) => void this.#onEvent(event))
      : () => undefined;
  }

  dispose(): void {
    this.#unsubscribe();
  }

  #onEvent(event: AgentEvent): void {
    if (event.type === "done") {
      void this.#push("任务完成", `会话「${this.#sessionTitle}」已完成。`);
    } else if (event.type === "error") {
      void this.#push("任务出错", `会话「${this.#sessionTitle}」出错：${event.message}`);
    } else if (
      event.type === "notify" &&
      (event.level === "error" || event.level === "warn")
    ) {
      void this.#push(
        event.level === "error" ? "任务出错" : "审批超时",
        `会话「${this.#sessionTitle}」：${event.message}`,
      );
    }
  }

  async #push(title: string, body: string): Promise<void> {
    const url = this.#webhookUrl;
    if (!url) return;
    if (!this.#allowPush()) return;

    try {
      const payload = buildPayload(url, title, body);
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // 推送失败不影响主流程：静默忽略（避免再触发推送形成循环）
    }
  }

  #allowPush(): boolean {
    const now = Date.now();
    const window = this.#rateWindow;
    if (now - window.start >= RATE_WINDOW_MS) {
      this.#rateWindow = { start: now, count: 0 };
    }
    if (this.#rateWindow.count >= PUSH_PER_HOUR) return false;
    this.#rateWindow.count += 1;
    return true;
  }
}

function buildPayload(
  url: string,
  title: string,
  body: string,
): Record<string, unknown> {
  if (url.includes("qyapi.weixin.qq.com")) {
    return {
      msgtype: "text",
      text: { content: `[MyAgent] ${title}\n${body}` },
    };
  }
  return { title, body };
}
