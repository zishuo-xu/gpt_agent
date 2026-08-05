import {
  readdir,
  readFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readOptional } from "../utils/fs.js";
import type { ConversationMessage } from "../model/types.js";
import { RepoMap } from "./repo-map.js";
import type { TodoItem } from "./types.js";

export interface ContextManagerOptions {
  cwd?: string;
  homeDir?: string;
  keepRecentUserTurns?: number;
  memoryLineLimit?: number;
  stateDir?: string;
  /** 注入其他项目记忆标题索引；处理敏感项目的用户可关闭（behavior.crossProjectMemory） */
  crossProjectMemory?: boolean;
}

export interface PreparedContext {
  system: string;
  messages: ConversationMessage[];
}

export class ContextManager {
  readonly #cwd: string | undefined;
  readonly #homeDir: string;
  readonly #keepRecentUserTurns: number;
  readonly #memoryLineLimit: number;
  readonly #stateDir: string;
  readonly #crossProjectMemory: boolean;
  #todos: TodoItem[] = [];
  #repoMap: RepoMap | null = null;
  /** RepoMap 首次获取后固化的快照：RepoMap 内部有 TTL 缓存，文件改动后会重建，
      若每轮重新 get() 会改变 system 内容破坏前缀缓存；会话内只注入首次快照 */
  #repoMapSnapshot: string | null = null;
  /** 跨项目记忆索引：会话内惰性生成一次，保证 system 前缀稳定（利于 prompt cache） */
  #crossProjectIndex: string | null = null;
  /** 记忆类静态段（AGENTS.md + 记忆文件 + 跨项目索引）：会话内只构建一次，
      参照 Pi 的 AGENTS.md 启动时加载——agent 运行中写记忆不刷新当前会话 system，
      保证前缀字节级稳定，最大化 prompt cache 命中 */
  #staticSections: string[] | null = null;

  constructor(options: ContextManagerOptions = {}) {
    this.#cwd = options.cwd;
    this.#homeDir = options.homeDir ?? os.homedir();
    this.#keepRecentUserTurns = options.keepRecentUserTurns ?? 3;
    this.#memoryLineLimit = options.memoryLineLimit ?? 200;
    this.#stateDir =
      options.stateDir ?? path.join(this.#homeDir, ".myagent");
    this.#crossProjectMemory = options.crossProjectMemory ?? true;
  }

  setTodos(todos: TodoItem[]): void {
    this.#todos = structuredClone(todos);
  }

  async prepare(
    baseSystemPrompt: string,
    messages: ConversationMessage[],
  ): Promise<PreparedContext> {
    if (this.#cwd && !this.#repoMap) {
      const hasExploration = messages.some(
        (m) =>
          m.role === "tool" &&
          (m.toolName === "Grep" ||
            m.toolName === "Glob" ||
            m.toolName === "Task"),
      );
      if (hasExploration) {
        this.#repoMap = new RepoMap(this.#cwd);
      }
    }
    const sections = [baseSystemPrompt];
    if (this.#cwd && this.#staticSections === null) {
      this.#staticSections = await this.#buildStaticSections();
    }
    if (this.#staticSections) {
      sections.push(...this.#staticSections);
    }
    if (this.#repoMap && this.#repoMapSnapshot === null) {
      const map = await this.#repoMap.get();
      if (map) {
        this.#repoMapSnapshot = map;
      }
    }
    if (this.#repoMapSnapshot) {
      sections.push(
        [
          "仓库签名地图（仅签名，用 Read 查看实现；用 Glob/Grep 探索更多）：",
          this.#repoMapSnapshot,
        ].join("\n"),
      );
    }
    // todos 随 TodoWrite 高频变化，绝不能进 system——否则 system 中一字节变化
    // 会让其后整个 messages 历史的缓存失效。因此注入为独立消息，且插在
    // 最后一条 user 消息之前，仅影响尾部缓存。
    const preparedMessages = applySoftForgetting(
      messages,
      this.#keepRecentUserTurns,
    );
    if (this.#todos.length > 0) {
      const todosText = [
        "当前任务清单（以此快照为准，状态变化请调用 TodoWrite 全量更新）：",
        ...this.#todos.map(
          (todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`,
        ),
      ].join("\n");
      const lastUserIndex = preparedMessages
        .map((message, index) =>
          message.role === "user" ? index : -1,
        )
        .filter((index) => index >= 0)
        .at(-1);
      preparedMessages.splice(lastUserIndex ?? 0, 0, {
        role: "user",
        content: todosText,
      });
    }
    return {
      system: sections.join("\n\n"),
      messages: preparedMessages,
    };
  }

  /** 构建记忆类静态段：AGENTS.md + 全局记忆 + 项目记忆 + 跨项目索引。
      仅在会话首次 prepare 时执行一次，之后复用，保证 system 前缀稳定。 */
  async #buildStaticSections(): Promise<string[]> {
    const sections: string[] = [];
    await this.#appendFileSection(
      sections,
      "项目指令（AGENTS.md）",
      path.join(this.#cwd!, "AGENTS.md"),
    );
    await this.#appendFileSection(
      sections,
      "全局记忆",
      path.join(this.#homeDir, ".myagent", "MEMORY.md"),
    );
    for (const [title, fileName] of [
      ["项目约定", "conventions.md"],
      ["项目踩坑", "pitfalls.md"],
      ["项目决策", "decisions.md"],
    ] as const) {
      await this.#appendFileSection(
        sections,
        title,
        path.join(this.#cwd!, ".myagent", "memory", fileName),
      );
    }
    const crossProjectIndex =
      this.#crossProjectIndex ??
      (await this.#buildCrossProjectMemoryIndex());
    this.#crossProjectIndex = crossProjectIndex;
    if (crossProjectIndex) {
      sections.push(
        [
          "其他项目记忆索引（仅标题；判断相关时用 Read 调取所列完整路径）：",
          crossProjectIndex,
        ].join("\n"),
      );
    }
    return sections;
  }

  async #buildCrossProjectMemoryIndex(): Promise<string> {
    if (!this.#crossProjectMemory) return "";
    const projectsDir = path.join(this.#stateDir, "projects");
    let projectKeys: string[];
    try {
      projectKeys = await readdir(projectsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
    const output: string[] = [];
    for (const key of projectKeys.slice(0, 100)) {
      const metadata = await readProjectMetadata(
        path.join(projectsDir, key, "project.json"),
      );
      if (
        !metadata ||
        !this.#cwd ||
        path.resolve(metadata.cwd) === path.resolve(this.#cwd)
      ) {
        continue;
      }
      const memoryDir = path.join(
        metadata.cwd,
        ".myagent",
        "memory",
      );
      for (const fileName of [
        "conventions.md",
        "pitfalls.md",
        "decisions.md",
      ]) {
        const filePath = path.join(memoryDir, fileName);
        const content = (await readOptional(filePath)) ?? "";
        const titles = content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(
            (line) =>
              line.startsWith("- ") ||
              /^#{1,3}\s/.test(line),
          )
          .slice(0, 8);
        for (const title of titles) {
          output.push(
            `- ${metadata.name} · ${filePath} · ${title.slice(0, 160)}`,
          );
        }
      }
    }
    return output.slice(0, 80).join("\n");
  }

  async #appendFileSection(
    sections: string[],
    title: string,
    filePath: string,
  ): Promise<void> {
    const content = (await readOptional(filePath)) ?? "";
    if (!content.trim()) return;
    const lines = content.split(/\r?\n/);
    const visible = lines.slice(0, this.#memoryLineLimit);
    sections.push(
      [
        `${title}：`,
        visible.join("\n"),
        ...(lines.length > visible.length
          ? [
              `[... ${lines.length - visible.length} 行未注入；需要时使用 Read 查看 ${filePath} ...]`,
            ]
          : []),
      ].join("\n"),
    );
  }
}

interface ProjectMetadata {
  name: string;
  cwd: string;
}

async function readProjectMetadata(
  filePath: string,
): Promise<ProjectMetadata | undefined> {
  try {
    const value = JSON.parse(
      await readFile(filePath, "utf8"),
    ) as Partial<ProjectMetadata>;
    if (!value.name || !value.cwd) return undefined;
    return { name: value.name, cwd: value.cwd };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    ) {
      return undefined;
    }
    throw error;
  }
}

export function applySoftForgetting(
  messages: ConversationMessage[],
  keepRecentUserTurns = 3,
): ConversationMessage[] {
  if (keepRecentUserTurns < 0) return structuredClone(messages);
  const userIndexes = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  const cutoff =
    keepRecentUserTurns === 0
      ? Number.POSITIVE_INFINITY
      : userIndexes.length > keepRecentUserTurns
        ? (userIndexes.at(-keepRecentUserTurns) ?? -1)
        : -1;
  return messages.map((message, index) => {
    if (message.role !== "tool" || index >= cutoff) {
      return structuredClone(message);
    }
    const location = message.target ? ` ${message.target}` : "";
    return {
      ...message,
      content:
        `[此前 ${message.toolName}${location} 的输出已省略。` +
        `如需恢复，请重新调用 ${message.toolName}。]`,
    };
  });
}
