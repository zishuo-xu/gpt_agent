import {
  readdir,
  readFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConversationMessage } from "../model/types.js";
import { RepoMap } from "./repo-map.js";
import type { TodoItem } from "./types.js";

export interface ContextManagerOptions {
  cwd?: string;
  homeDir?: string;
  keepRecentUserTurns?: number;
  memoryLineLimit?: number;
  stateDir?: string;
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
  #todos: TodoItem[] = [];
  #repoMap: RepoMap | null = null;

  constructor(options: ContextManagerOptions = {}) {
    this.#cwd = options.cwd;
    this.#homeDir = options.homeDir ?? os.homedir();
    this.#keepRecentUserTurns = options.keepRecentUserTurns ?? 3;
    this.#memoryLineLimit = options.memoryLineLimit ?? 200;
    this.#stateDir =
      options.stateDir ?? path.join(this.#homeDir, ".myagent");
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
    if (this.#cwd) {
      await this.#appendFileSection(
        sections,
        "项目指令（AGENTS.md）",
        path.join(this.#cwd, "AGENTS.md"),
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
          path.join(this.#cwd, ".myagent", "memory", fileName),
        );
      }
      const crossProjectIndex =
        await this.#buildCrossProjectMemoryIndex();
      if (crossProjectIndex) {
        sections.push(
          [
            "其他项目记忆索引（仅标题；判断相关时用 Read 调取所列完整路径）：",
            crossProjectIndex,
          ].join("\n"),
        );
      }
      if (this.#repoMap) {
        const map = await this.#repoMap.get();
        if (map) {
          sections.push(
            [
              "仓库签名地图（仅签名，用 Read 查看实现；用 Glob/Grep 探索更多）：",
              map,
            ].join("\n"),
          );
        }
      }
    }
    if (this.#todos.length > 0) {
      sections.push(
        [
          "当前任务清单（以此快照为准，状态变化请调用 TodoWrite 全量更新）：",
          ...this.#todos.map(
            (todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`,
          ),
        ].join("\n"),
      );
    }
    return {
      system: sections.join("\n\n"),
      messages: applySoftForgetting(
        messages,
        this.#keepRecentUserTurns,
      ),
    };
  }

  async #buildCrossProjectMemoryIndex(): Promise<string> {
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
        const content = await readOptional(filePath);
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
    const content = await readOptional(filePath);
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

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
