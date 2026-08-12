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

/**
 * Bash 链式命令切分：按 `&&` / `||` / `;` 分段，忽略引号（" 与 '）内的操作符。
 * 单 `&`（后台）与单 `|`（管道）不切分——重定向 `2>&1`、管道过滤是常见只读形态，
 * 应留在段内参与整段规则匹配。
 */
function splitBashChain(target: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < target.length; index++) {
    const char = target[index]!;
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const operator =
      char === ";" ||
      (char === "&" && target[index + 1] === "&") ||
      (char === "|" && target[index + 1] === "|");
    if (operator) {
      const trimmed = current.trim();
      if (trimmed) segments.push(trimmed);
      current = "";
      if (char !== ";") index++; // 跳过 && / || 的第二个字符
      continue;
    }
    current += char;
  }
  const trimmed = current.trim();
  if (trimmed) segments.push(trimmed);
  return segments;
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
    // Bash 链式命令（&& / || / ; 多段）：整串 ask/allow 对前缀锚定规则
    // （如 `Bash(ls*)` / `Bash(pwd*)`）有误放行风险（`ls && git push`），
    // 因此多段命令不再看整串 ask/allow，一律段级判定：
    // 任一段 deny/ask 即拦截，全段 allow 才放行，否则落入模式兜底。
    if (call.tool === "Bash") {
      const segments = splitBashChain(call.target);
      if (segments.length > 1) {
        if (segments.some((segment) => matchesEffect("deny", this.#rules, { ...call, target: segment }))) {
          return "deny";
        }
        if (segments.some((segment) => matchesEffect("ask", this.#rules, { ...call, target: segment }))) {
          return "ask";
        }
        if (segments.every((segment) => matchesEffect("allow", this.#rules, { ...call, target: segment }))) {
          return "allow";
        }
        // strict 下 Bash 已在上方 STRICT_GATED 返回，此处只剩 normal / trust
        return this.#mode === "trust" ? "allow" : "ask";
      }
    }
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
  { effect: "allow", pattern: "Bash(pwd*)" },
  // 只读原语：cat/find/head/tail/wc/sort/grep 本身无写副作用，模型只读任务常用
  { effect: "allow", pattern: "Bash(cat*)" },
  { effect: "allow", pattern: "Bash(find*)" },
  { effect: "allow", pattern: "Bash(head*)" },
  { effect: "allow", pattern: "Bash(tail*)" },
  { effect: "allow", pattern: "Bash(wc*)" },
  { effect: "allow", pattern: "Bash(sort*)" },
  { effect: "allow", pattern: "Bash(grep*)" },
  { effect: "allow", pattern: "Bash(git status*)" },
  { effect: "allow", pattern: "Bash(git diff*)" },
  { effect: "allow", pattern: "Bash(npm test*)" },
  { effect: "allow", pattern: "Bash(pnpm test*)" },
  { effect: "ask", pattern: "Bash(git commit*)" },
  { effect: "ask", pattern: "Bash(git push*)" },
  { effect: "deny", pattern: "Bash(rm -rf *)" },
  { effect: "deny", pattern: "Bash(*rm *-rf *)" },
  { effect: "deny", pattern: "Bash(*rm *-fr *)" },
  // find 的执行形态：-exec / -delete 是删除通道，必须显式拦截
  { effect: "deny", pattern: "Bash(*find *-exec*)" },
  { effect: "deny", pattern: "Bash(*find *-delete*)" },
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
