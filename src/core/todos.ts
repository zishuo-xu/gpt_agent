import type { TodoItem, TodoStatus } from "./types.js";

const STATUSES = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
]);

export class TodoStore {
  #items: TodoItem[] = [];

  snapshot(): TodoItem[] {
    return structuredClone(this.#items);
  }

  replace(items: TodoItem[]): TodoItem[] {
    const ids = new Set<string>();
    let inProgress = 0;
    const normalized = items.map((item, index) => {
      const id = String(item.id ?? "").trim();
      const content = String(item.content ?? "").trim();
      const status = item.status as TodoStatus;
      if (!id) throw new Error(`Todo 第 ${index + 1} 项缺少 id`);
      if (ids.has(id)) throw new Error(`Todo id 重复：${id}`);
      if (!content) throw new Error(`Todo“${id}”内容不能为空`);
      if (!STATUSES.has(status)) {
        throw new Error(`Todo“${id}”状态无效：${String(status)}`);
      }
      ids.add(id);
      if (status === "in_progress") inProgress += 1;
      return { id, content, status };
    });
    if (inProgress > 1) {
      throw new Error("Todo 同一时刻只能有一项处于 in_progress");
    }
    this.#items = normalized;
    return this.snapshot();
  }
}
