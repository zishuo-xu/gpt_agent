import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  abortableSleep,
  abortError,
} from "./sleep.js";
import {
  atomicWriteFile,
  readJsonl,
  readOptional,
} from "./fs.js";
import { escapeRegExp } from "./regexp.js";
import { stringify } from "./stringify.js";
import { usageCostCny } from "./cost.js";
import {
  globToRegExp,
  normalizeSlashes,
} from "./glob.js";

test("readOptional：存在返回内容，不存在返回 null，且不吞其他错误", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-utils-"));
  const file = path.join(dir, "a.txt");
  await writeFile(file, "hello");
  assert.equal(await readOptional(file), "hello");
  assert.equal(await readOptional(path.join(dir, "missing.txt")), null);
  // 目录路径触发 EISDIR 而非 ENOENT，应原样抛出
  await assert.rejects(readOptional(dir), (error: NodeJS.ErrnoException) => {
    assert.notEqual(error.code, "ENOENT");
    return true;
  });
});

test("atomicWriteFile：内容原子落盘 + 默认权限 0600", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-utils-"));
  const file = path.join(dir, "sub", "data.json");
  await atomicWriteFile(file, JSON.stringify({ ok: true }));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ok: true });
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
  // 目录递归创建
  assert.ok((await stat(path.join(dir, "sub"))).isDirectory());
});

test("atomicWriteFile：覆盖已有文件时保留原权限位", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-utils-"));
  const file = path.join(dir, "data.txt");
  await writeFile(file, "old", { mode: 0o644 });
  await atomicWriteFile(file, "new");
  assert.equal(await readFile(file, "utf8"), "new");
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o644, "覆盖不应改写既有文件权限");
});

test("atomicWriteFile：信号已中止时不落盘且清理临时文件", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-utils-"));
  const file = path.join(dir, "data.txt");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    atomicWriteFile(file, "content", { signal: controller.signal }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  await assert.rejects(stat(file), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "中止后不得残留临时文件");
});

test("abortableSleep：未中止时等待后 resolve", async () => {
  const controller = new AbortController();
  const started = Date.now();
  await abortableSleep(30, controller.signal);
  assert.ok(Date.now() - started >= 20);
});

test("abortableSleep：中止立即 reject AbortError；预中止直接 reject", async () => {
  const controller = new AbortController();
  const pending = abortableSleep(10_000, controller.signal);
  const started = Date.now();
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.ok(Date.now() - started < 1000, "中止应即时生效");
  // 预中止信号
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(abortableSleep(10_000, pre.signal), (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(abortError().name, "AbortError");
});

test("readJsonl：坏行跳过不抛错，统计跳过数", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-utils-"));
  const file = path.join(dir, "events.jsonl");
  const good1 = { seq: 1, text: "第一行" };
  const good2 = { seq: 3, text: "第三行" };
  await writeFile(
    file,
    [
      JSON.stringify(good1),
      '{"seq": 2, "text": "半行残', // 崩溃残留：JSON 不完整
      JSON.stringify(good2),
      "", // 空行忽略
      "not-json-at-all", // 完全损坏
    ].join("\n") + "\n",
  );
  const { records, skipped } = await readJsonl<{ seq: number; text: string }>(
    file,
  );
  assert.deepEqual(records, [good1, good2]);
  assert.equal(skipped, 2);
  // 尾部半行（追加写中断）同样只跳过，不抛错
  await writeFile(file, JSON.stringify(good1) + "\n" + '{"seq": 2');
  const tail = await readJsonl<{ seq: number }>(file);
  assert.equal(tail.records.length, 1);
  assert.equal(tail.skipped, 1);
});

test("escapeRegExp：转义元字符，* 保留为量词（通配语义由 globToRegExp 上层处理）", () => {
  const escaped = escapeRegExp("a.b[c]d+e?");
  const re = new RegExp(`^${escaped}$`);
  assert.match("a.b[c]d+e?", re);
  assert.doesNotMatch("axbxcxdxex", re);
  // * 不被转义（保留正则量词语义）
  assert.match("abbbc", new RegExp(`^${escapeRegExp("ab*c")}$`));
  assert.doesNotMatch("abxc", new RegExp(`^${escapeRegExp("ab*c")}$`));
});

test("stringify：字符串原样、对象 JSON 化、循环引用兜底 String", () => {
  assert.equal(stringify("already-text"), "already-text");
  assert.equal(stringify({ a: 1 }), '{"a":1}');
  assert.equal(stringify([1, 2]), "[1,2]");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(typeof stringify(circular), "string");
  assert.equal(stringify(null), "null");
});

test("usageCostCny：按单价折算，未配置单价返回 undefined", () => {
  const pricing = {
    inputPerMillionCny: 10,
    outputPerMillionCny: 20,
    cachedInputPerMillionCny: 2,
  };
  // 1M input 全热读 + 0.5M output + 0.2M cached
  const cost = usageCostCny({ input: 1_200_000, output: 500_000, cached: 200_000 }, pricing);
  assert.ok(cost !== undefined);
  // (1.2M-0.2M)*10 + 0.5M*20 + 0.2M*2 = 10 + 10 + 0.4 = 20.4
  assert.equal(cost, 20.4);
  assert.equal(usageCostCny({ input: 100, output: 100, cached: 0 }), undefined);
});

test("globToRegExp：星号/双星/问号语义与路径分隔符", () => {
  assert.match("src/app.ts", globToRegExp("src/*.ts"));
  assert.doesNotMatch("src/deep/app.ts", globToRegExp("src/*.ts"));
  assert.match("src/deep/app.ts", globToRegExp("src/**/*.ts"));
  assert.match("src/app.ts", globToRegExp("src/**/*.ts"), "** 可匹配零层目录");
  assert.match("a/b", globToRegExp("?/b"));
  assert.doesNotMatch("ab/b", globToRegExp("?/b"));
});

test("normalizeSlashes：按平台分隔符统一为 /", () => {
  // 平台分隔符（POSIX `/`，Windows `\`）会被转成 `/`
  const withSep = `a${path.sep}b${path.sep}c`;
  assert.equal(normalizeSlashes(withSep), "a/b/c");
  assert.equal(normalizeSlashes("a/b"), "a/b");
});
