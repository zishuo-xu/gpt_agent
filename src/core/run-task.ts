import { randomUUID } from "node:crypto";
import type {
  PermissionMode,
  PermissionRule,
} from "./types.js";

export interface RunTaskOptions {
  description: string;
  goal?: string;
  bounds?: string;
  until?: string;
  deadline?: string;
  budgetCny?: number;
  permission?: PermissionMode;
  hardRules: PermissionRule[];
  semanticBounds: string[];
  /** 定时执行：首次执行时间（ISO；--at HH:mm 解析，今天过期自动 +1 天） */
  at?: string;
  /** 定时执行：周期（分钟；--every N 解析；缺省一次性） */
  everyMinutes?: number;
}

export interface TaskBoxDecision {
  instruction?: string;
  level?: "narrow" | "wrapup" | "final";
  finalOnly?: boolean;
  stop?: boolean;
  reason?: "deadline" | "budget";
}

export class TaskBox {
  readonly id: string;
  readonly options: RunTaskOptions;
  readonly #startCostCny: number;
  readonly #deadlineMs: number | undefined;
  readonly #emitted = new Set<string>();

  constructor(
    options: RunTaskOptions,
    startCostCny: number,
    id?: string,
  ) {
    this.id = id ?? randomUUID().slice(0, 8);
    this.options = options;
    this.#startCostCny = startCostCny;
    this.#deadlineMs = options.deadline
      ? Date.parse(options.deadline)
      : undefined;
  }

  prompt(): string {
    const hardBounds = this.options.hardRules
      .map((rule) => rule.pattern)
      .join(", ");
    return [
      `[无人值守任务 #${this.id}]`,
      `任务：${this.options.description}`,
      this.options.goal
        ? `机器验收目标：${this.options.goal}`
        : "机器验收目标：未指定；完成合理验证后自然停止。",
      this.options.bounds
        ? `用户边界：${this.options.bounds}`
        : "用户边界：未额外指定。",
      hardBounds
        ? `硬边界（权限引擎 deny，不能绕过）：${hardBounds}`
        : "",
      this.options.semanticBounds.length
        ? `软语义边界（路径规则无法完全保证，必须严格遵守）：${this.options.semanticBounds.join("；")}`
        : "",
      this.options.deadline
        ? `截止时间：${this.options.deadline}`
        : "",
      this.options.budgetCny === undefined
        ? ""
        : `本任务预算：¥${this.options.budgetCny.toFixed(2)}`,
      "",
      "持续工作直至目标完成或任务盒要求收尾。每轮都用实际命令验证，不要仅凭判断宣称完成。",
      "收尾固定包含：改动与验证总结、todo 完成/未完成/卡点、值得写入记忆的稳定事实。",
    ]
      .filter(Boolean)
      .join("\n");
  }

  check(nowMs: number, totalCostCny: number): TaskBoxDecision {
    const budget = this.options.budgetCny;
    if (budget !== undefined) {
      const spent = Math.max(0, totalCostCny - this.#startCostCny);
      const remainingRatio = (budget - spent) / budget;
      if (remainingRatio <= 0) {
        return this.#once("budget-final", {
          instruction:
            "预算盒已耗尽。停止所有工具调用，立即输出收尾总结、todo 快照与未完成项。",
          level: "final",
          finalOnly: true,
          reason: "budget",
        });
      }
      if (remainingRatio <= 0.1) {
        return this.#once("budget-wrapup", {
          instruction:
            "任务预算剩余不足 10%。立即收尾：优先确保代码可编译/测试通过，更新 todo 并准备总结。",
          level: "wrapup",
          reason: "budget",
        });
      }
      if (remainingRatio <= 0.3) {
        return this.#once("budget-narrow", {
          instruction:
            "任务预算已使用约 70%。停止开启新的大改动，收窄范围并优先完成当前闭环。",
          level: "narrow",
          reason: "budget",
        });
      }
    }

    if (this.#deadlineMs === undefined) return {};
    const remainingMs = this.#deadlineMs - nowMs;
    if (remainingMs <= 0) {
      return { stop: true, reason: "deadline" };
    }
    if (remainingMs <= 2 * 60_000) {
      return this.#once("time-final", {
        instruction:
          "距离截止不足 2 分钟。停止所有工具调用，立即输出收尾总结、todo 快照与未完成项。",
        level: "final",
        finalOnly: true,
        reason: "deadline",
      });
    }
    if (remainingMs <= 10 * 60_000) {
      return this.#once("time-wrapup", {
        instruction:
          "距离截止不足 10 分钟。立即收尾：确保代码可编译/测试通过，更新 todo，记录稳定记忆并准备总结。",
        level: "wrapup",
        reason: "deadline",
      });
    }
    if (remainingMs <= 30 * 60_000) {
      return this.#once("time-narrow", {
        instruction:
          "距离截止不足 30 分钟。评估进度，停止开启新的大改动，优先完成手头闭环。",
        level: "narrow",
        reason: "deadline",
      });
    }
    return {};
  }

  #once(key: string, decision: TaskBoxDecision): TaskBoxDecision {
    if (this.#emitted.has(key)) {
      return decision.finalOnly ? { finalOnly: true } : {};
    }
    this.#emitted.add(key);
    return decision;
  }
}

export function parseRunCommand(
  command: string,
  now = new Date(),
): RunTaskOptions {
  const tokens = tokenize(command.trim());
  if (tokens[0] === "/run") tokens.shift();
  const description: string[] = [];
  const values = new Map<string, string>();
  const known = new Set([
    "--goal",
    "--bounds",
    "--until",
    "--budget",
    "--permission",
    "--at",
    "--every",
  ]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!known.has(token)) {
      description.push(token);
      continue;
    }
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} 缺少参数`);
    }
    values.set(token, value);
    index += 1;
  }
  const task = description.join(" ").trim();
  if (!task) throw new Error("/run 后需要任务描述");

  const permissionValue = values.get("--permission");
  if (
    permissionValue &&
    !["strict", "normal", "trust"].includes(permissionValue)
  ) {
    throw new Error("--permission 必须是 strict、normal 或 trust");
  }
  const budgetValue = values.get("--budget");
  const budgetCny =
    budgetValue === undefined ? undefined : Number(budgetValue);
  if (
    budgetCny !== undefined &&
    (!Number.isFinite(budgetCny) || budgetCny <= 0)
  ) {
    throw new Error("--budget 必须是大于 0 的人民币金额");
  }
  const until = values.get("--until");
  const deadline = until ? parseDeadline(until, now) : undefined;
  const bounds = values.get("--bounds");
  const goal = values.get("--goal");
  const atValue = values.get("--at");
  const at = atValue ? parseAtTime(atValue, now) : undefined;
  const everyValue = values.get("--every");
  const everyMinutes =
    everyValue === undefined ? undefined : Number(everyValue);
  if (
    everyMinutes !== undefined &&
    (!Number.isInteger(everyMinutes) || everyMinutes <= 0)
  ) {
    throw new Error("--every 必须是大于 0 的整数分钟");
  }
  const compiled = compileBounds(bounds);
  return {
    description: task,
    ...(goal ? { goal } : {}),
    ...(bounds ? { bounds } : {}),
    ...(until ? { until } : {}),
    ...(deadline ? { deadline } : {}),
    ...(budgetCny === undefined ? {} : { budgetCny }),
    ...(permissionValue
      ? { permission: permissionValue as PermissionMode }
      : {}),
    ...(at ? { at: at.toISOString() } : {}),
    ...(everyMinutes === undefined ? {} : { everyMinutes }),
    ...compiled,
  };
}

/**
 * 解析 --at HH:mm：今天该时刻；已过则顺延到明天（与 --until 语义一致）。
 * 返回 undefined 表示未提供。
 */
export function parseAtTime(value: string, now = new Date()): Date | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new Error("--at 必须是 HH:mm 格式（如 09:00）");
  const target = new Date(now);
  target.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

/**
 * 从 /run 命令中剥离定时规格（--at / --every）：
 * 注册定时任务时落库存"可立即执行"的干净命令，调度信息由
 * ScheduledTask.at / everyMinutes 单独承载，避免到期执行时二次解析带出调度字段。
 */
export function stripScheduleFlags(command: string): string {
  const tokens = tokenize(command.trim());
  if (tokens[0] === "/run") tokens.shift();
  const remaining: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--at" || token === "--every") {
      // 解析器保证这两个参数必带值，跳过下一个 token
      index += 1;
      continue;
    }
    remaining.push(token);
  }
  return ["/run", ...remaining].join(" ");
}

export function compileBounds(
  bounds?: string,
): {
  hardRules: PermissionRule[];
  semanticBounds: string[];
} {
  if (!bounds?.trim()) return { hardRules: [], semanticBounds: [] };
  const paths = new Set<string>();
  // 全量保护语义："不改任何文件 / 所有文件 / 整个项目 / 全部" → 禁止一切写操作
  if (/(任何文件|所有文件|全部文件|整个项目|全部)/.test(bounds)) {
    paths.add("*");
  }
  for (const match of bounds.matchAll(
    /(?:不改|不要改|禁止修改|不动|排除)\s*([A-Za-z0-9_.*/-]+\/?)/g,
  )) {
    const value = match[1]?.trim();
    if (value && (value.includes("/") || value.includes("*"))) {
      paths.add(value.replace(/^\.\//, ""));
    }
  }
  const hardRules: PermissionRule[] = [];
  for (const candidate of paths) {
    const pattern = candidate.endsWith("*")
      ? candidate
      : candidate.endsWith("/")
        ? `${candidate}*`
        : `${candidate}*`;
    for (const tool of ["Edit", "MultiEdit", "Write"]) {
      hardRules.push({
        effect: "deny",
        pattern: `${tool}(*${pattern})`,
      });
    }
  }
  const semanticBounds = bounds
    .split(/[，,；;]/)
    .map((item) => item.trim())
    .filter(
      (item) =>
        item.length > 0 &&
        ![...paths].some((candidate) => item.includes(candidate)),
    );
  return { hardRules, semanticBounds };
}

/** 把 RunTaskOptions 序列化为可入事件流的形态（run_started 事件持久化用） */
export function serializeTaskOptions(
  options: RunTaskOptions,
): NonNullable<AgentEventRunStarted["taskOptions"]> {
  return {
    description: options.description,
    ...(options.goal ? { goal: options.goal } : {}),
    ...(options.bounds ? { bounds: options.bounds } : {}),
    ...(options.until ? { until: options.until } : {}),
    ...(options.deadline ? { deadline: options.deadline } : {}),
    ...(options.budgetCny === undefined
      ? {}
      : { budgetCny: options.budgetCny }),
    ...(options.permission ? { permission: options.permission } : {}),
    hardRules: structuredClone(options.hardRules),
    semanticBounds: [...options.semanticBounds],
  };
}

/** 从 run_started 事件的 taskOptions 反序列化（崩溃恢复续跑用） */
export function taskOptionsFromSerialized(
  taskOptions: NonNullable<AgentEventRunStarted["taskOptions"]>,
): RunTaskOptions {
  return {
    description: taskOptions.description,
    ...(taskOptions.goal ? { goal: taskOptions.goal } : {}),
    ...(taskOptions.bounds ? { bounds: taskOptions.bounds } : {}),
    ...(taskOptions.until ? { until: taskOptions.until } : {}),
    ...(taskOptions.deadline ? { deadline: taskOptions.deadline } : {}),
    ...(taskOptions.budgetCny === undefined
      ? {}
      : { budgetCny: taskOptions.budgetCny }),
    ...(taskOptions.permission
      ? { permission: taskOptions.permission }
      : {}),
    hardRules: structuredClone(taskOptions.hardRules),
    semanticBounds: [...taskOptions.semanticBounds],
  };
}

type AgentEventRunStarted = {
  type: "run_started";
  taskOptions?: {
    description: string;
    goal?: string;
    bounds?: string;
    until?: string;
    deadline?: string;
    budgetCny?: number;
    permission?: PermissionMode;
    hardRules: PermissionRule[];
    semanticBounds: string[];
  };
};

function parseDeadline(value: string, now: Date): string {
  if (/^\d{1,2}:\d{2}$/.test(value)) {
    const [hourText, minuteText] = value.split(":");
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (hour > 23 || minute > 59) {
      throw new Error("--until 时间格式无效");
    }
    const deadline = new Date(now);
    deadline.setHours(hour, minute, 0, 0);
    if (deadline.getTime() <= now.getTime()) {
      deadline.setDate(deadline.getDate() + 1);
    }
    return deadline.toISOString();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) {
    throw new Error("--until 必须是未来的 HH:mm 或 ISO 时间");
  }
  return new Date(timestamp).toISOString();
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (quote) throw new Error("命令存在未闭合引号");
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}
