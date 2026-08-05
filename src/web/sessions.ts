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
import { parseRunCommand } from "../core/run-task.js";

export type WebSessionEvent = AgentSessionEvent;
export type WebSessionStatus = AgentSessionStatus;
export type WebSessionSummary = AgentSessionSummary;

/**
 * 大厅模式权限规则：可读（Read/Grep/Glob）但禁一切写操作。
 * Bash 是唯一能逃逸路径约束写文件的工具，一并禁用。
 */
export const LOBBY_PERMISSION_RULES: PermissionRule[] = [
  { effect: "deny", pattern: "Edit(*)" },
  { effect: "deny", pattern: "MultiEdit(*)" },
  { effect: "deny", pattern: "Write(*)" },
  { effect: "deny", pattern: "Bash(*)" },
];

export class WebSessionManager extends AgentSessionManager {
  readonly #lobby: boolean;

  constructor(
    cwd: string,
    configService: ConfigService,
    options: { lobby?: boolean; stateDir?: string } = {},
  ) {
    super({
      cwd,
      configService,
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
    });
    this.#lobby = options.lobby === true;
  }

  get lobby(): boolean {
    return this.#lobby;
  }

  async create(
    message: string,
    mode: PermissionMode = "normal",
  ): Promise<AgentSession> {
    const extraPermissionRules = this.#lobby
      ? LOBBY_PERMISSION_RULES
      : undefined;
    if (message.trim().startsWith("/run")) {
      const task = parseRunCommand(message);
      const session = await this.createSession({
        title: task.description,
        mode,
        ...(extraPermissionRules ? { extraPermissionRules } : {}),
      });
      session.startRunTask(task);
      return session;
    }
    return await this.createSession({
      initialMessage: message,
      mode,
      ...(extraPermissionRules ? { extraPermissionRules } : {}),
    });
  }
}
