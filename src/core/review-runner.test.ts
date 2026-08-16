import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPrompt, parseReviewResult } from "./review-runner.js";

test("parseReviewResult：PASS 结论", () => {
  const result = parseReviewResult(
    "Verdict: PASS\n\nIssues: （无）\n\nUnconfirmed: 无",
  );
  assert.equal(result.passed, true);
  assert.deepEqual(result.issues, []);
});

test("parseReviewResult：FAIL + 问题清单", () => {
  const result = parseReviewResult(
    "Verdict: FAIL\nIssues:\n- src/App.tsx:12 待办状态未持久化\n- 缺少测试文件\nUnconfirmed: 无",
  );
  assert.equal(result.passed, false);
  assert.ok(result.issues.length >= 2);
  assert.match(result.issues[0] ?? "", /App\.tsx:12/);
});

test("parseReviewResult：无法识别时 passed=false 且说明原因", () => {
  const result = parseReviewResult("好的，我完成了。");
  assert.equal(result.passed, false);
  assert.ok((result.summary ?? "").length > 0);
});

test("buildReviewPrompt：包含任务要求、改动文件与 todo 状态", () => {
  const prompt = buildReviewPrompt({
    taskReq: "搭一个待办应用",
    modifiedFiles: ["src/App.tsx", "src/lib/todos.ts"],
    lastVerification: "pnpm build 通过",
    todos: [{ content: "写核心逻辑", status: "completed" }],
  });
  assert.match(prompt, /搭一个待办应用/);
  assert.match(prompt, /src\/App\.tsx/);
  assert.match(prompt, /pnpm build 通过/);
  assert.match(prompt, /写核心逻辑/);
});

test("parseReviewResult：无结构时按中文通过词宽松判定", () => {
  assert.equal(parseReviewResult("正确").passed, true);
  assert.equal(parseReviewResult("审查通过").passed, true);
  assert.equal(parseReviewResult("未通过，还有问题").passed, false);
  assert.equal(parseReviewResult("审查").passed, false);
});

test("parseReviewResult：宽松词表覆盖英文与中文变体", () => {
  assert.equal(parseReviewResult("confirmed").passed, true);
  assert.equal(parseReviewResult("符合预期").passed, true);
  assert.equal(parseReviewResult("无误").passed, true);
  assert.equal(parseReviewResult("未通过审查").passed, false);
});
