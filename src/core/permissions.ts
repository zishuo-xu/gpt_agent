import type {
  PermissionEffect,
  PermissionMode,
  PermissionRule,
  ToolCall,
} from "./types.js";
import { escapeRegExp } from "../utils/regexp.js";
import os from "node:os";
import path from "node:path";

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

/** 文件工具（target 是文件路径，判定前需规范化与执行路径同构） */
const FILE_TOOLS = new Set<string>(["Edit", "MultiEdit", "Write"]);

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
 * 文件工具 target 规范化：`~`/`~/` 展开为主目录、相对路径 resolve 到 cwd，
 * 使判定对象与执行对象（executor.#resolve）是同一路径——杜绝
 * `Edit(/Users/x/.ssh/a)` 绕过 `Edit(~/.ssh/*)`、`Edit(src/../src/secret/x)`
 * 绕过 `Edit(*src/secret*)` 的字面匹配旁路。
 */
export function normalizeFileTarget(target: string, cwd: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/")) {
    return path.resolve(cwd, path.join(os.homedir(), target.slice(2)));
  }
  return path.resolve(cwd, target);
}

/**
 * 规则 pattern 中的 `~` 前缀展开为主目录（与 target 规范化同构）。
 * 仅处理工具签名内、路径起点位置的 `~`（`Edit(~/.ssh/*)`）；引号等字面场景不受影响。
 */
function expandTildeInPattern(pattern: string, home: string): string {
  return pattern.replace(
    /^([A-Za-z][\w-]*)\(~(?=\/|\))/,
    (_match, tool: string) => `${tool}(${home}`,
  );
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

/**
 * 段内重定向目标是否为空输出丢弃（`> /dev/null` / `&> /dev/null`）：
 * 丢弃输出不写盘，属于无害形态，不算写副作用。
 */
function isDevNullRedirect(target: string, from: number): boolean {
  let index = from;
  while (index < target.length && /\s/.test(target[index]!)) index++;
  if (!target.startsWith("/dev/null", index)) return false;
  // 目标必须是完整词（后随空白/结束/`2>&1` 之类的重定向起始符）
  const after = target[index + "/dev/null".length];
  return after === undefined || /\s/.test(after) || after === ">" || after === "&";
}

/**
 * 段是否产生文件写副作用（引号感知）：
 * - 写重定向 `>` / `>>` / `>|` / `N>file`（排除 fd 复制 `2>&1`/`>&1` 与 `> /dev/null` 丢弃）
 * - `tee`（含 `tee -a`）：无论是否接文件参数都视为写盘通道
 * 只读白名单（Bash(cat*) 等）按前缀匹配，带写重定向的段必须被识别——
 * 否则 `cat x > out.txt` 会静默绕过只读判定。
 */
export function segmentWritesFile(segment: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      // `2>&1` / `>&1`：`>` 后紧跟 `&` 是 fd 复制，不写盘
      if (segment[index + 1] === "&") continue;
      // `>>` / `>|`：追加/强制覆盖，写盘
      // `> /dev/null`：丢弃输出，不写盘
      if (isDevNullRedirect(segment, index + 1)) {
        // 跳过整个 /dev/null 目标词，避免其中的 `>` 误判（`2> /dev/null`）
        let skip = index + 1;
        while (skip < segment.length && /\s/.test(segment[skip]!)) skip++;
        index = skip + "/dev/null".length - 1;
        continue;
      }
      return true;
    }
  }
  // tee：段按引号外 `|` 切子命令，子命令首词为 tee（含 tee -a）→ 写盘
  let commandStart = true;
  quote = null;
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "|") {
      commandStart = true;
      continue;
    }
    if (commandStart) {
      if (/\s/.test(char)) continue;
      const word = segment.slice(index).match(/^\S+/)?.[0] ?? "";
      if (word === "tee") return true;
      commandStart = false;
    }
  }
  return false;
}

/** 规则集是否含只读写保护（deny 的 Edit(*)/Write(*)/MultiEdit(*)）：
 * TaskRunner readonly 子代理、用户自定义禁写规则命中；普通会话无。 */
function hasWriteDenyProtection(rules: PermissionRule[]): boolean {
  return rules.some(
    (rule) =>
      rule.effect === "deny" &&
      (rule.pattern === "Edit(*)" ||
        rule.pattern === "Write(*)" ||
        rule.pattern === "MultiEdit(*)"),
  );
}

/**
 * DEFAULT_PERMISSION_RULES 的只读原语动词（cat/ls/pwd/find/head/tail/wc/sort/grep/git
 * 只读形态/npm|pnpm test）——系统预设的"只读语义" allow：命令本身无写副作用，
 * 带写重定向（`cat x > out`）即不再只读，不得放行。
 * 用户显式授权（--auto-allow / 自定义 allow 规则）语义即放行命令（含其写副作用），
 * 不在此列——写重定向拦截只针对系统只读原语。
 */
const READONLY_BASH_VERBS = [
  "cat",
  "ls",
  "pwd",
  "find",
  "head",
  "tail",
  "wc",
  "sort",
  "grep",
  "git status",
  "git diff",
  "npm test",
  "pnpm test",
  // 环境探查（搭建场景高频）：版本/工具定位/环境变量，无写副作用
  "node -v",
  "node --version",
  "pnpm -v",
  "npm -v",
  "yarn -v",
  "npm view",
  "pnpm view",
  "uname",
  "which",
  "command -v",
  "env",
];

function isReadonlyPrimitiveAllow(rule: PermissionRule): boolean {
  if (rule.effect !== "allow" || !rule.pattern.startsWith("Bash(")) {
    return false;
  }
  const verb = rule.pattern.slice("Bash(".length);
  return READONLY_BASH_VERBS.some((prefix) => verb.startsWith(prefix));
}

export class PermissionEngine {
  #mode: PermissionMode;
  #rules: PermissionRule[];
  readonly #cwd: string;

  constructor(
    mode: PermissionMode,
    rules: PermissionRule[] = [],
    options: { cwd?: string } = {},
  ) {
    this.#mode = mode;
    // 规则与 target 同构规范化：pattern 中的 `~` 展开为主目录，
    // 使绝对路径形态的 target 同样命中 `~` 开头的 deny/allow 规则
    this.#rules = rules.map((rule) => ({
      ...rule,
      pattern: expandTildeInPattern(rule.pattern, os.homedir()),
    }));
    this.#cwd = options.cwd ?? process.cwd();
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  setMode(mode: PermissionMode): void {
    this.#mode = mode;
  }

  setRules(rules: PermissionRule[]): void {
    this.#rules = rules.map((rule) => ({
      ...rule,
      pattern: expandTildeInPattern(rule.pattern, os.homedir()),
    }));
  }

  rules(): PermissionRule[] {
    return structuredClone(this.#rules);
  }

  remember(call: ToolCall): void {
    // 与 judge 同构：文件工具按规范化签名记忆，避免授权后因路径形态不同失配
    if (FILE_TOOLS.has(call.tool)) {
      this.rememberPattern(
        callSignature({
          ...call,
          target: normalizeFileTarget(call.target, this.#cwd),
        }),
      );
      return;
    }
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
    // 文件工具：先规范化 target（~ 展开 + resolve），与执行路径同构后再判定
    if (FILE_TOOLS.has(call.tool)) {
      const normalized = normalizeFileTarget(call.target, this.#cwd);
      const fileCall = { ...call, target: normalized };
      if (matchesEffect("deny", this.#rules, fileCall)) return "deny";
      if (this.#mode === "strict" && STRICT_GATED.has(call.tool)) {
        return "ask";
      }
      if (matchesEffect("ask", this.#rules, fileCall)) return "ask";
      if (matchesEffect("allow", this.#rules, fileCall)) return "allow";
      if (this.#mode === "trust") return "allow";
      if (this.#mode === "normal" && NORMAL_AUTO.has(call.tool)) {
        return "allow";
      }
      if (this.#mode === "strict") return "allow";
      return "ask";
    }
    if (matchesEffect("deny", this.#rules, call)) return "deny";
    if (this.#mode === "strict" && STRICT_GATED.has(call.tool)) return "ask";
    // Bash 链式命令（&& / || / ; 多段）：整串 ask/allow 对前缀锚定规则
    // （如 `Bash(ls*)` / `Bash(pwd*)`）有误放行风险（`ls && git push`），
    // 因此统一段级判定（单段与多段同路径）：
    // 任一段 deny/ask 即拦截；写重定向段（`cat x > out`）不得由只读原语
    // 白名单前缀放行（只读环境 deny、其余落入模式兜底），用户显式授权
    // （--auto-allow / 自定义 allow）语义即放行命令含其写副作用，不受此限；
    // 全段 allow 才放行，否则落入模式兜底。
    if (call.tool === "Bash") {
      const segments = splitBashChain(call.target);
      if (segments.some((segment) => matchesEffect("deny", this.#rules, { ...call, target: segment }))) {
        return "deny";
      }
      if (segments.some((segment) => matchesEffect("ask", this.#rules, { ...call, target: segment }))) {
        return "ask";
      }
      const writeSegments = segments.filter(segmentWritesFile);
      if (writeSegments.length > 0) {
        // 写重定向段是否被显式授权（非只读原语的 allow 规则）放行
        const explicitlyAllowed = writeSegments.every((segment) => {
          const allows = this.#rules.filter(
            (rule) => rule.effect === "allow" && matches(rule, { ...call, target: segment }),
          );
          return allows.some((rule) => !isReadonlyPrimitiveAllow(rule));
        });
        if (!explicitlyAllowed) {
          // 只读环境（TaskRunner readonly 子代理等）：写重定向 = 写操作，直接拒绝
          return hasWriteDenyProtection(this.#rules)
            ? "deny"
            : this.#mode === "trust"
              ? "allow"
              : "ask";
        }
      }
      if (segments.every((segment) => matchesEffect("allow", this.#rules, { ...call, target: segment }))) {
        return "allow";
      }
      // strict 下 Bash 已在上方 STRICT_GATED 返回，此处只剩 normal / trust
      return this.#mode === "trust" ? "allow" : "ask";
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
  // 环境探查（搭建场景高频）：版本/工具定位/环境变量，无写副作用
  { effect: "allow", pattern: "Bash(node -v*)" },
  { effect: "allow", pattern: "Bash(node --version*)" },
  { effect: "allow", pattern: "Bash(pnpm -v*)" },
  { effect: "allow", pattern: "Bash(npm -v*)" },
  { effect: "allow", pattern: "Bash(yarn -v*)" },
  { effect: "allow", pattern: "Bash(npm view*)" },
  { effect: "allow", pattern: "Bash(pnpm view*)" },
  { effect: "allow", pattern: "Bash(uname*)" },
  { effect: "allow", pattern: "Bash(which*)" },
  { effect: "allow", pattern: "Bash(command -v*)" },
  { effect: "allow", pattern: "Bash(env*)" },
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
