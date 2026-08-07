import type {
  PermissionEffect,
  PermissionMode,
  PermissionRule,
  ToolCall,
} from "./types.js";
import { escapeRegExp } from "../utils/regexp.js";

export type PermissionVerdict = PermissionEffect;

// 工具名集合随插件通道开放（ToolCall.tool: string），划分按字面量比较即可
const STRICT_GATED = new Set<string>([
  "Edit",
  "MultiEdit",
  "Write",
  "Bash",
]);
const NORMAL_AUTO = new Set<string>([
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
  "Task",
  "Edit",
  "MultiEdit",
]);

function wildcardToRegExp(pattern: string): RegExp {
  const source = escapeRegExp(pattern).replaceAll("*", ".*");
  return new RegExp(`^${source}$`);
}

export function callSignature(call: ToolCall): string {
  return `${call.tool}(${call.target})`;
}

function matches(rule: PermissionRule, call: ToolCall): boolean {
  return wildcardToRegExp(rule.pattern).test(callSignature(call));
}

function matchesEffect(
  effect: PermissionEffect,
  rules: PermissionRule[],
  call: ToolCall,
): boolean {
  return rules.some((rule) => rule.effect === effect && matches(rule, call));
}

export class PermissionEngine {
  #mode: PermissionMode;
  #rules: PermissionRule[];

  constructor(mode: PermissionMode, rules: PermissionRule[] = []) {
    this.#mode = mode;
    this.#rules = [...rules];
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  setMode(mode: PermissionMode): void {
    this.#mode = mode;
  }

  setRules(rules: PermissionRule[]): void {
    this.#rules = [...rules];
  }

  rules(): PermissionRule[] {
    return structuredClone(this.#rules);
  }

  remember(call: ToolCall): void {
    this.rememberPattern(callSignature(call));
  }

  /** 按 pattern 记忆 allow 规则（去重；插件工具 session 级放行使用通配形态） */
  rememberPattern(pattern: string): void {
    if (
      this.#rules.some(
        (rule) => rule.effect === "allow" && rule.pattern === pattern,
      )
    ) {
      return;
    }
    this.#rules.push({ effect: "allow", pattern });
  }

  judge(call: ToolCall): PermissionVerdict {
    if (matchesEffect("deny", this.#rules, call)) return "deny";
    if (this.#mode === "strict" && STRICT_GATED.has(call.tool)) return "ask";
    if (matchesEffect("ask", this.#rules, call)) return "ask";
    if (matchesEffect("allow", this.#rules, call)) return "allow";
    if (this.#mode === "trust") return "allow";
    if (this.#mode === "normal" && NORMAL_AUTO.has(call.tool)) return "allow";
    if (this.#mode === "strict") return "allow";
    return "ask";
  }
}

export const DEFAULT_PERMISSION_RULES: PermissionRule[] = [
  { effect: "allow", pattern: "Write(*.myagent/memory/*)" },
  { effect: "allow", pattern: "Edit(*.myagent/memory/*)" },
  { effect: "allow", pattern: "MultiEdit(*.myagent/memory/*)" },
  { effect: "allow", pattern: "Write(*.myagent/MEMORY.md)" },
  { effect: "allow", pattern: "Edit(*.myagent/MEMORY.md)" },
  { effect: "allow", pattern: "Bash(ls*)" },
  { effect: "allow", pattern: "Bash(git status*)" },
  { effect: "allow", pattern: "Bash(git diff*)" },
  { effect: "allow", pattern: "Bash(npm test*)" },
  { effect: "allow", pattern: "Bash(pnpm test*)" },
  { effect: "ask", pattern: "Bash(git commit*)" },
  { effect: "ask", pattern: "Bash(git push*)" },
  { effect: "deny", pattern: "Bash(rm -rf *)" },
  { effect: "deny", pattern: "Bash(*rm *-rf *)" },
  { effect: "deny", pattern: "Bash(*rm *-fr *)" },
  { effect: "deny", pattern: "Bash(git reset*)" },
  { effect: "deny", pattern: "Bash(git clean*)" },
  { effect: "deny", pattern: "Bash(git checkout -- *)" },
  { effect: "deny", pattern: "Edit(~/.ssh/*)" },
  { effect: "deny", pattern: "Write(~/.ssh/*)" },
];

/** 只读会话的基础写保护（Task 子代理 readonly 模式与 Web 大厅模式共用） */
export const READONLY_DENY_RULES: PermissionRule[] = [
  { effect: "deny", pattern: "Edit(*)" },
  { effect: "deny", pattern: "MultiEdit(*)" },
  { effect: "deny", pattern: "Write(*)" },
];
