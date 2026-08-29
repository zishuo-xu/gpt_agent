import type { ConfigService } from "../config/service.js";
import {
  AgentSessionManager,
} from "../core/session-manager.js";
import {
  AgentSession,
  type AgentSessionEvent,
  type AgentSessionStatus,
  type AgentSessionSummary,
} from "../core/session.js";
import type { PermissionMode, PermissionRule } from "../core/types.js";
import { READONLY_DENY_RULES } from "../core/permissions.js";
import { parseRunCommand } from "../core/run-task.js";
import type { AtomicFileTools } from "../tools/atomic-file.js";
import type { RunWorkspaceMode } from "../core/run-workspace.js";

export interface WebWorkspaceInfo {
  mode: "isolated";
  sourceCwd: string;
  path: string;
  head: string;
  warnings: string[];
  exists: boolean;
}

export type WebSessionEvent = AgentSessionEvent;
export type WebSessionStatus = AgentSessionStatus;
export type WebSessionSummary = AgentSessionSummary;

/**
 * 大厅模式权限规则：只读基础写保护（Edit/MultiEdit/Write）之上，
 * 额外禁用 Bash——唯一能逃逸路径约束写文件的工具。
 */
export const LOBBY_PERMISSION_RULES: PermissionRule[] = [
  ...READONLY_DENY_RULES,
  { effect: "deny", pattern: "Bash(*)" },
];

export class WebSessionManager extends AgentSessionManager {
  readonly #lobby: boolean;

  constructor(
    cwd: string,
    configService: ConfigService,
    options: {
      lobby?: boolean;
      stateDir?: string;
      /** 文件工具实现（可注入记忆留档钩子等）；缺省每个会话新建 */
      files?: AtomicFileTools;
    } = {},
  ) {
    super({
      cwd,
      configService,
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      ...(options.files ? { files: options.files } : {}),
    });
    this.#lobby = options.lobby === true;
  }

  get lobby(): boolean {
    return this.#lobby;
  }

  async create(
    message: string,
    mode: PermissionMode = "normal",
    options: { planMode?: boolean; workspaceMode?: RunWorkspaceMode } = {},
  ): Promise<AgentSession> {
    if (this.#lobby && options.workspaceMode === "isolated") {
      throw new Error("大厅没有 Git 工作区，不能使用隔离执行");
    }
    const extraPermissionRules = this.#lobby
      ? LOBBY_PERMISSION_RULES
      : undefined;
    if (options.planMode === true) {
      const session = await this.createSession({
        title: message.trim().slice(0, 40),
        mode,
        ...(extraPermissionRules ? { extraPermissionRules } : {}),
        ...(options.workspaceMode ? { workspaceMode: options.workspaceMode } : {}),
      });
      await session.startPlan(message);
      return session;
    }
    if (message.trim().startsWith("/run")) {
      const task = parseRunCommand(message);
      const session = await this.createSession({
        title: task.description,
        mode,
        ...(extraPermissionRules ? { extraPermissionRules } : {}),
        ...(options.workspaceMode ? { workspaceMode: options.workspaceMode } : {}),
      });
      session.startRunTask(task);
      return session;
    }
    return await this.createSession({
      initialMessage: message,
      mode,
      ...(extraPermissionRules ? { extraPermissionRules } : {}),
      ...(options.workspaceMode ? { workspaceMode: options.workspaceMode } : {}),
    });
  }
}
