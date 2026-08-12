import path from "node:path";
import type { LedgerUnit } from "./types.js";

/**
 * 任务执行账本（Task Ledger）：/run 无人值守任务的显式进度记录。
 *
 * Phase 1 只含系统自动记账通道：Edit/MultiEdit/Write 命中即标记 done。
 * 模型侧显式确认（verified/blocked/pending）为 Phase 2 扩展，状态机已预留。
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
   * 系统自动记账：文件被 Edit/MultiEdit/Write 实际修改后标记 done。
   * - 已登记单元（LedgerInit 声明过）→ 状态置 done
   * - 未登记文件 → 自动补集新建单元（计划漂移不丢信息）
   * 返回变更单元；无变更（幂等重复命中）返回 undefined。
   */
  markFileWritten(filePath: string): LedgerUnit | undefined {
    const existing = this.#units.get(filePath);
    if (existing) {
      if (existing.status === "done") return undefined;
      const unit: LedgerUnit = {
        ...existing,
        status: "done",
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
      status: "done",
      note: "系统自动记录：文件已修改，待验证",
      updatedAt: new Date().toISOString(),
    };
    this.#units.set(created.id, created);
    this.#updatedAt = created.updatedAt;
    return created;
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
