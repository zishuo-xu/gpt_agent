import { spawn } from "node:child_process";
import type { AgentEvent } from "./types.js";
import type { AgentSessionSummary } from "./session.js";

/**
 * 外部 webhook 推送器。
 *
 * 订阅会话事件流，把"需要用户知道"的事件推送到配置的 webhook：
 * - 任务完成（done / run_finished completed）
 * - 任务出错（error / notify.error / run_finished failed）
 * - 任务中断（run_finished interrupted）
 * - 审批超时（notify.warn，由会话在超时拒绝时发出）
 *
 * 推送纪律（与设计文档一致）：只推需要知道的，不推主动汇报；
 * 同一会话每小时最多 2 条，超限丢弃。
 *
 * 格式自动适配：
 * - 企业微信机器人（qyapi.weixin.qq.com）→ { msgtype: "text", text: { content } }
 * - 飞书自定义机器人（open.feishu.cn / open.larksuite.com）→ { msg_type: "text", content: { text } }
 * - Bark（day.app）→ { title, body }
 * - 其他网关 → { title, body }（通用 JSON POST）
 */

const PUSH_PER_HOUR = 2;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const RUN_FINISHED_STATUS = {
  completed: "已完成",
  failed: "已失败",
  interrupted: "已中断",
} as const;

/** 推送附带的结构化字段（通用网关 JSON 顶层扩展；企微/飞书文本格式不携带） */
interface PushMeta {
  status?: string;
  sessionId?: string;
  costCny?: number;
  tokens?: number;
  durationMs?: number;
}

interface RateWindow {
  start: number;
  count: number;
}

export class WebhookNotifier {
  readonly #webhookUrl: string | undefined;
  readonly #sessionTitle: string;
  readonly #getSummary: (() => AgentSessionSummary | undefined) | undefined;
  readonly #unsubscribe: () => void;
  #rateWindow: RateWindow = { start: Date.now(), count: 0 };

  constructor(
    subscribe: (listener: (event: AgentEvent) => void) => () => void,
    options: {
      webhookUrl?: string;
      sessionTitle: string;
      /** 推送任务结果时附带 耗时/费用/tokens（会话 summary 提供） */
      getSummary?: () => AgentSessionSummary | undefined;
    },
  ) {
    this.#webhookUrl = options.webhookUrl?.trim() || undefined;
    this.#sessionTitle = options.sessionTitle;
    this.#getSummary = options.getSummary;
    this.#unsubscribe = this.#webhookUrl
      ? subscribe((event) => void this.#onEvent(event))
      : () => undefined;
  }

  dispose(): void {
    this.#unsubscribe();
  }

  #onEvent(event: AgentEvent): void {
    if (event.type === "done") {
      // /run 会话的终态由 run_finished 推送（信息更全：状态+耗时+费用），
      // 会话结束时的 done 与之重复，跳过避免双推（交互会话无 run_finished，照常推送）
      if (this.#getSummary?.()?.kind === "run") return;
      void this.#push("任务完成", `会话「${this.#sessionTitle}」已完成。`);
    } else if (event.type === "run_finished") {
      // 无人值守任务终态：completed / failed / interrupted（含收尾摘要与花费）
      const status = RUN_FINISHED_STATUS[event.status] ?? "已结束";
      const reason =
        event.reason && event.reason !== "done"
          ? `（${event.reason}）`
          : "";
      const summary = this.#getSummary?.();
      const detail = this.#summaryDetail();
      void this.#push(
        `任务${status}`,
        `会话「${this.#sessionTitle}」的无人值守任务${status}${reason}。${detail}`,
        {
          status: event.status,
          ...(summary
            ? {
                sessionId: summary.id,
                costCny: summary.totalCostCny,
                tokens: summary.totalInputTokens,
                durationMs: Math.max(
                  0,
                  Date.parse(summary.updatedAt) -
                    Date.parse(summary.createdAt),
                ),
              }
            : {}),
        },
      );
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

  /** 任务结果摘要：耗时 / 费用 / 输入 tokens（summary 缺失时留空） */
  #summaryDetail(): string {
    const summary = this.#getSummary?.();
    if (!summary) return "";
    const minutes = Math.max(
      0,
      Math.round(
        (Date.parse(summary.updatedAt) - Date.parse(summary.createdAt)) /
          60_000,
      ),
    );
    return `耗时 ${minutes} 分钟 · 费用 ¥${summary.totalCostCny.toFixed(2)} · 输入 ${summary.totalInputTokens} tokens`;
  }

  async #push(
    title: string,
    body: string,
    meta?: PushMeta,
  ): Promise<void> {
    const url = this.#webhookUrl;
    if (!url) return;
    if (!this.#allowPush()) return;

    try {
      const payload = buildPayload(url, title, body, meta);
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
  meta?: PushMeta,
): Record<string, unknown> {
  if (url.includes("qyapi.weixin.qq.com")) {
    return {
      msgtype: "text",
      text: { content: `[MyAgent] ${title}\n${body}` },
    };
  }
  if (
    url.includes("open.feishu.cn") ||
    url.includes("open.larksuite.com")
  ) {
    return {
      msg_type: "text",
      content: { text: `[MyAgent] ${title}\n${body}` },
    };
  }
  // 通用网关（Bark 等）：title/body 之上附带结构化字段，机器人可做卡片
  return { title, body, ...(meta ?? {}) };
}

/**
 * macOS 桌面通知（通知中心）：订阅会话事件流，在任务完成/出错/审批超时
 * 时弹出系统通知——无需浏览器常驻。非 macOS 平台自动跳过。
 * 限速与 webhook 一致（同会话每小时 2 条），避免刷屏。
 */
export class DesktopNotifier {
  readonly #enabled: boolean;
  readonly #sessionTitle: string;
  readonly #unsubscribe: () => void;
  readonly #notifyFn: (title: string, body: string) => void;
  #rateWindow: RateWindow = { start: Date.now(), count: 0 };

  constructor(
    subscribe: (listener: (event: AgentEvent) => void) => () => void,
    options: {
      enabled: boolean;
      sessionTitle: string;
      platform?: NodeJS.Platform;
      /** 注入通知执行器（测试用）；缺省走 osascript */
      notify?: (title: string, body: string) => void;
    },
  ) {
    this.#enabled =
      options.enabled && (options.platform ?? process.platform) === "darwin";
    this.#sessionTitle = options.sessionTitle;
    this.#notifyFn =
      options.notify ?? ((title, body) => osascriptNotify(title, body));
    this.#unsubscribe = this.#enabled
      ? subscribe((event) => this.#onEvent(event))
      : () => undefined;
  }

  dispose(): void {
    this.#unsubscribe();
  }

  #onEvent(event: AgentEvent): void {
    if (event.type === "done") {
      this.#push("任务完成", `会话「${this.#sessionTitle}」已完成。`);
    } else if (event.type === "run_finished") {
      const status = RUN_FINISHED_STATUS[event.status] ?? "已结束";
      this.#push(
        `任务${status}`,
        `会话「${this.#sessionTitle}」的无人值守任务${status}。`,
      );
    } else if (event.type === "error") {
      this.#push("任务出错", `会话「${this.#sessionTitle}」出错：${event.message}`);
    } else if (
      event.type === "notify" &&
      (event.level === "error" || event.level === "warn")
    ) {
      this.#push(
        event.level === "error" ? "任务出错" : "审批超时",
        `会话「${this.#sessionTitle}」：${event.message}`,
      );
    }
  }

  #push(title: string, body: string): void {
    if (!this.#allowPush()) return;
    try {
      this.#notifyFn(title, body);
    } catch {
      // 通知失败不影响主流程
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

/** 经 osascript 调起 macOS 通知中心（异步 spawn，失败静默） */
function osascriptNotify(title: string, body: string): void {
  const script =
    `display notification ${shellQuote(body)} with title ${shellQuote(`MyAgent · ${title}`)}`;
  const child = spawn("osascript", ["-e", script], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

/** AppleScript 字符串转义（单引号包裹 + 内部转义） */
function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
