import assert from "node:assert/strict";
import test from "node:test";
import { TodoStore } from "./todos.js";

test("TodoStore.replace：归一化 id/content 并返回快照", () => {
  const store = new TodoStore();
  const snapshot = store.replace([
    { id: " a ", content: " 写核心逻辑 ", status: "pending" },
    { id: "b", content: "跑测试", status: "completed" },
  ]);
  assert.deepEqual(snapshot, [
    { id: "a", content: "写核心逻辑", status: "pending" },
    { id: "b", content: "跑测试", status: "completed" },
  ]);
  assert.equal(store.snapshot().length, 2);
});

test("TodoStore.replace：快照与内部状态隔离（外部修改不污染）", () => {
  const store = new TodoStore();
  const snapshot = store.replace([
    { id: "a", content: "x", status: "pending" },
  ]);
  snapshot[0]!.content = "被外部修改";
  assert.equal(store.snapshot()[0]?.content, "x");
});

test("TodoStore.replace：缺 id / 重复 id / 空内容 / 非法状态报错", () => {
  const store = new TodoStore();
  assert.throws(
    () => store.replace([{ id: "", content: "x", status: "pending" }]),
    /缺少 id/,
  );
  assert.throws(
    () =>
      store.replace([
        { id: "a", content: "x", status: "pending" },
        { id: "a", content: "y", status: "pending" },
      ]),
    /Todo id 重复/,
  );
  assert.throws(
    () => store.replace([{ id: "a", content: "  ", status: "pending" }]),
    /内容不能为空/,
  );
  assert.throws(
    () =>
      store.replace([
        { id: "a", content: "x", status: "oops" as never },
      ]),
    /状态无效/,
  );
});

test("TodoStore.replace：多个 in_progress 报错且不污染既有数据", () => {
  const store = new TodoStore();
  store.replace([{ id: "a", content: "x", status: "in_progress" }]);
  assert.throws(
    () =>
      store.replace([
        { id: "a", content: "x", status: "in_progress" },
        { id: "b", content: "y", status: "in_progress" },
      ]),
    /只能有一项处于 in_progress/,
  );
  assert.equal(store.snapshot()[0]?.status, "in_progress");
  assert.equal(store.snapshot().length, 1);
});
