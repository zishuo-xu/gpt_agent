import path from "node:path";
import type { LedgerUnit, PlanExecutionUnit } from "./types.js";

/**
 * 任务执行账本（Task Ledger）：批准计划与 /run 任务的显式进度记录。
 *
 * TodoWrite 推进逻辑步骤；Edit/MultiEdit/Write 仅证明文件被修改，
 * 因此文件先标记 in_progress，只有验收或完成审查通过后才标记 verified。
 *
 * 账本状态：
 * - 事件流是唯一事实源（ledger_update 事件增量写入，恢复时逐条投影重建）
 * - 本类为纯内存投影（applyUpdate），不含 IO（快照落盘随 P1 事件流分段一并做）
 */
export class TaskLedger {
  readonly taskId: string;
  #units = new Map<string, LedgerUnit>();
  #updatedAt: string;

  constructor(taskId: string, restoredUnits?: readonly LedgerUnit[]) {
    this.taskId = taskId;
    this.#updatedAt = new Date().toISOString();
    if (restoredUnits) {
      for (const unit of restoredUnits) {
        this.#units.set(unit.id, { ...unit });
      }
    }
  }

  /**
   * 系统自动记账：文件被 Edit/MultiEdit/Write 实际修改后标记 in_progress。
   * - 已登记单元（LedgerInit 声明过）→ 状态置 in_progress
   * - 未登记文件 → 自动补集新建单元（计划漂移不丢信息）
   * 返回变更单元；无变更（幂等重复命中）返回 undefined。
   */
  markFileWritten(filePath: string): LedgerUnit | undefined {
    const existing = this.#units.get(filePath);
    if (existing) {
      if (existing.status === "in_progress") return undefined;
      const unit: LedgerUnit = {
        ...existing,
        status: "in_progress",
        note: "系统自动记录：文件已修改，待验证",
        updatedAt: new Date().toISOString(),
      };
      this.#units.set(unit.id, unit);
      this.#updatedAt = unit.updatedAt;
      return unit;
    }
    const created: LedgerUnit = {
      id: filePath,
      kind: "file",
      label: filePath,
      status: "in_progress",
      note: "系统自动记录：文件已修改，待验证",
      updatedAt: new Date().toISOString(),
    };
    this.#units.set(created.id, created);
    this.#updatedAt = created.updatedAt;
    return created;
  }

  /** 将批准计划步骤登记为稳定的任务单元；已有状态和证据不会被覆盖。 */
  initializeTaskUnits(units: readonly PlanExecutionUnit[]): LedgerUnit[] {
    const changed: LedgerUnit[] = [];
    for (const item of units) {
      if (this.#units.has(item.id)) continue;
      const unit: LedgerUnit = {
        id: item.id,
        kind: "task",
        label: item.content,
        status: "pending",
        updatedAt: new Date().toISOString(),
      };
      this.#units.set(unit.id, unit);
      changed.push(unit);
    }
    if (changed.length > 0) this.#updatedAt = changed.at(-1)!.updatedAt;
    return changed;
  }

  markNextPendingInProgress(): LedgerUnit | undefined {
    const current = [...this.#units.values()].find(
      (unit) => unit.status === "pending",
    );
    if (!current) return undefined;
    const unit: LedgerUnit = { ...current, status: "in_progress", updatedAt: new Date().toISOString() };
    this.#units.set(unit.id, unit);
    this.#updatedAt = unit.updatedAt;
    return unit;
  }

  applyTodoStatus(
    id: string,
    status: "pending" | "in_progress" | "completed",
  ): LedgerUnit | undefined {
    const current = this.#units.get(id);
    if (!current || current.kind !== "task") return undefined;
    const next: LedgerUnit["status"] = status === "completed" ? "done" : status;
    if (current.status === next) return undefined;
    const unit: LedgerUnit = { ...current, status: next, updatedAt: new Date().toISOString() };
    this.#units.set(id, unit);
    this.#updatedAt = unit.updatedAt;
    return unit;
  }

  /** 验收/完成审查通过后升级未阻塞单元；失败路径不得调用。 */
  markVerified(evidence: string): LedgerUnit[] {
    const changed: LedgerUnit[] = [];
    for (const current of this.#units.values()) {
      if (current.kind === "task" && current.status !== "done") continue;
      if (
        current.kind === "file" &&
        current.status !== "done" &&
        current.status !== "in_progress"
      ) {
        continue;
      }
      const unit: LedgerUnit = {
        ...current,
        status: "verified",
        evidence,
        updatedAt: new Date().toISOString(),
      };
      this.#units.set(unit.id, unit);
      changed.push(unit);
    }
    if (changed.length > 0) this.#updatedAt = changed.at(-1)!.updatedAt;
    return changed;
  }

  /** 恢复投影：应用一条 ledger_update 增量事件 */
  applyUpdate(unit: LedgerUnit): void {
    this.#units.set(unit.id, { ...unit });
    if (unit.updatedAt > this.#updatedAt) {
      this.#updatedAt = unit.updatedAt;
    }
  }

  /** 全量快照（序列化视图） */
  snapshot(): { taskId: string; updatedAt: string; units: LedgerUnit[] } {
    return {
      taskId: this.taskId,
      updatedAt: this.#updatedAt,
      units: [...this.#units.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    };
  }

  /** 恢复注入用摘要：已完成计数 + 剩余清单（pending/in_progress/blocked） */
  toSummary(): {
    total: number;
    done: number;
    verified: number;
    remaining: LedgerUnit[];
  } {
    const units = [...this.#units.values()];
    return {
      total: units.length,
      done: units.filter((unit) => unit.status === "done").length,
      verified: units.filter((unit) => unit.status === "verified").length,
      remaining: units
        .filter(
          (unit) =>
            unit.status !== "done" && unit.status !== "verified",
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  get unitCount(): number {
    return this.#units.size;
  }

  hasUnits(): boolean {
    return this.#units.size > 0;
  }
}

/**
 * 路径规范化：绝对/相对路径统一为相对 cwd 的 POSIX 斜杠路径（账本单元 id）。
 * - 绝对路径 → 相对化；相对路径 → 原样规范化
 * - 反斜杠（Windows 风格）→ 正斜杠
 * - 越界（../ 逃出 cwd）→ 保留绝对形态（不强行相对化造成歧义）
 */
export function normalizeLedgerPath(cwd: string, filePath: string): string {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    // 逃出 cwd 或无法相对化：保留绝对路径（POSIX 化）
    return normalizeSlashes(absolute);
  }
  return normalizeSlashes(relative);
}

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}
