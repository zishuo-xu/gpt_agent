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
import type { PermissionMode } from "../core/types.js";
import { parseRunCommand } from "../core/run-task.js";

export { AgentSession as WebAgentSession };
export type WebSessionEvent = AgentSessionEvent;
export type WebSessionStatus = AgentSessionStatus;
export type WebSessionSummary = AgentSessionSummary;

export class WebSessionManager extends AgentSessionManager {
  constructor(cwd: string, configService: ConfigService) {
    super({ cwd, configService });
  }

  async create(
    message: string,
    mode: PermissionMode = "normal",
  ): Promise<AgentSession> {
    if (message.trim().startsWith("/run")) {
      const task = parseRunCommand(message);
      const session = await this.createSession({
        title: task.description,
        mode,
      });
      session.startRunTask(task);
      return session;
    }
    return await this.createSession({
      initialMessage: message,
      mode,
    });
  }
}
