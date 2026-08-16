import type { TodoItem } from "./types.js";

/** 审查结论：三段式（Verdict / Issues / Unconfirmed）宽容解析 */
export function parseReviewResult(raw: string): {
  passed: boolean;
  issues: string[];
  summary: string;
} {
  const lines = raw.split(/\r?\n/);
  const verdictLine = lines.find((line) => /verdict/i.test(line));
  const passed = /verdict\s*:\s*pass/i.test(verdictLine ?? "");
  let collecting = false;
  const issues: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^issues\s*:/i.test(trimmed)) {
      collecting = true;
      continue;
    }
    if (/^unconfirmed\s*:/i.test(trimmed)) {
      collecting = false;
      continue;
    }
    if (collecting && trimmed) {
      issues.push(trimmed.replace(/^[-•*]\s*/, ""));
    }
  }
  if (!/verdict/i.test(raw)) {
    // 宽松识别：模型未遵循三段式时，按中文/英文通过词判定
    const trimmed = raw.trim();
    const hasFailWord = /未通过|失败|不通过|有问题|fail/i.test(trimmed);
    const hasPassWord = /通过|正确|没问题|ok|pass|完成/i.test(trimmed);
    if (!hasFailWord && hasPassWord) {
      return { passed: true, issues: [], summary: trimmed };
    }
    const clipped =
      trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
    return {
      passed: false,
      issues: [`审查未返回结构化结论：${clipped}`],
      summary: clipped,
    };
  }
  return {
    passed,
    issues: passed ? [] : issues,
    summary: raw.trim(),
  };
}

/** 审查 prompt：任务要求 + 改动文件 + 验证结果 + todo，要求三段式结论 */
export function buildReviewPrompt(input: {
  taskReq: string;
  modifiedFiles: string[];
  lastVerification?: string;
  todos: Array<Pick<TodoItem, "content" | "status">>;
}): string {
  const files =
    input.modifiedFiles.length > 0
      ? input.modifiedFiles.map((file) => `- ${file}`).join("\n")
      : "（无文件修改记录）";
  const todos =
    input.todos.length > 0
      ? input.todos
          .map((todo) => `- ${todo.content}（${todo.status}）`)
          .join("\n")
      : "（无任务清单）";
  return `[完成审查] 你是独立的验收审查员。原始任务要求：
${input.taskReq}

本轮改动文件：
${files}

最近验证结果：
${input.lastVerification ?? "（未运行验证命令）"}

任务清单状态：
${todos}

请逐项核对任务要求是否满足。可用 Read/Grep/Glob 查看实际文件内容，用 Bash 仅运行验证类命令（test/build/lint/typecheck）。禁止修改任何文件。

Return exactly three sections:
Verdict: PASS 或 FAIL（全部要求满足且验证通过才 PASS）
Issues: 不通过时逐条列出问题（含 文件:行号 证据）；通过时写（无）
Unconfirmed: 未能确认的部分

Example output:
Verdict: FAIL
Issues:
- src/App.tsx:12 待办状态未持久化（localStorage 读写缺失）
- 缺少测试文件 src/lib/todos.test.ts
Unconfirmed: 无`;
}
