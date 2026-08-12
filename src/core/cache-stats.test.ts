import assert from "node:assert/strict";
import test from "node:test";
import {
  computeMissedTokens,
  missedCost,
  shouldShowCacheMissNotice,
} from "./cache-stats.js";

const usage = (cached: number, input = 5000) => ({
  input,
  output: 200,
  cached,
});
const now = 1_000_000;
// 无空闲（紧邻上一轮）
const recent = now - 60_000;

test("reportedCache sticky：从未命中缓存的供应商不计 miss（OpenAI 兼容端点防误报）", () => {
  // 有上轮输入、无任何缓存历史 → 不计 miss（DeepSeek 等 cached 恒 0）
  const result = computeMissedTokens(
    usage(0),
    5000,
    recent,
    now,
    0,
    0,
    false,
    false,
  );
  assert.deepEqual(result, { missedTokens: 0 });
  // 多轮后依然不计（sticky false 持续）
  assert.deepEqual(
    computeMissedTokens(usage(0), 9000, recent, now, 0, 0, false, false),
    { missedTokens: 0 },
  );
});

test("reportedCache sticky：见过命中后 miss 正常计入，压缩/切换/空闲原因保留", () => {
  const ever = true;
  // 上轮 5000，本轮 cached=0 → 全部 miss
  assert.equal(
    computeMissedTokens(usage(0), 5000, recent, now, 0, 0, false, ever)
      .missedTokens,
    5000,
  );
  // 部分命中 → 只计未命中部分（expectedCached = min(prev, input)）
  assert.equal(
    computeMissedTokens(usage(3000), 5000, recent, now, 0, 0, false, ever)
      .missedTokens,
    2000,
  );
  // 本轮输入小于上轮 → expected 取下限
  assert.equal(
    computeMissedTokens(usage(0), 5000, recent, now, 0, 0, false, ever)
      .missedTokens,
    5000,
  );
});

test("reportedCache sticky：压缩重置 prev 不影响标志（置位后永不重置）", () => {
  // 见过缓存（ever=true）→ 压缩后仍继续度量（压缩自身原因单独标注）
  const result = computeMissedTokens(
    usage(0, 8000),
    8000,
    recent,
    now,
    1,
    0,
    false,
    true,
  );
  assert.equal(result.missedTokens, 8000);
  assert.equal(result.missedReason, "compaction");
});

test("miss 原因分类：compaction > model_switch > idle", () => {
  const ever = true;
  assert.equal(
    computeMissedTokens(usage(0), 5000, recent, now, 2, 1, false, ever)
      .missedReason,
    "compaction",
  );
  assert.equal(
    computeMissedTokens(usage(0), 5000, recent, now, 1, 1, true, ever)
      .missedReason,
    "model_switch",
  );
  // 空闲超 5 分钟
  assert.equal(
    computeMissedTokens(usage(0), 5000, now - 6 * 60_000, now, 0, 0, false, ever)
      .missedReason,
    "idle",
  );
  // 无异常 → 无原因
  assert.deepEqual(
    computeMissedTokens(usage(0), 5000, recent, now, 0, 0, false, ever),
    { missedTokens: 5000 },
  );
});

test("噪音底与前置条件：无上轮输入不计；<1024 忽略", () => {
  const ever = true;
  assert.deepEqual(computeMissedTokens(usage(0), 0, recent, now, 0, 0, false, ever), {
    missedTokens: 0,
  });
  // 1023 tokens miss → 噪音忽略
  assert.deepEqual(
    computeMissedTokens(usage(0), 1023, recent, now, 0, 0, false, ever),
    { missedTokens: 0 },
  );
  // 恰好 1024 → 计入
  assert.equal(
    computeMissedTokens(usage(0), 1024, recent, now, 0, 0, false, ever)
      .missedTokens,
    1024,
  );
});

test("missedCost：压缩不计浪费；无定价不计；按输入-缓存价差估算", () => {
  const pricing = {
    inputPerMillionCny: 4,
    outputPerMillionCny: 16,
    cachedInputPerMillionCny: 1,
  };
  assert.equal(missedCost(5000, "compaction", pricing), undefined);
  assert.equal(missedCost(0, undefined, pricing), undefined);
  assert.equal(missedCost(5000, undefined, undefined), undefined);
  // 5000 tokens × (4-1)/1M = 0.015
  assert.equal(missedCost(5000, undefined, pricing), 0.015);
  assert.equal(missedCost(5000, "idle", pricing), 0.015);
});

test("shouldShowCacheMissNotice：阈值 20k tokens / ¥0.1 门控", () => {
  assert.equal(shouldShowCacheMissNotice(undefined, undefined), false);
  assert.equal(shouldShowCacheMissNotice(19_999, 0), false);
  assert.equal(shouldShowCacheMissNotice(20_000, 0), true);
  assert.equal(shouldShowCacheMissNotice(0, 0.09), false);
  assert.equal(shouldShowCacheMissNotice(0, 0.1), true);
});
