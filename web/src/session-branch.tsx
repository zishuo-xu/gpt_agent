import type { ReactNode } from "react";
import type { SessionBranch } from "@shared/types.js";

/** 右栏统一卡片容器 */
export function RailCard(props: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rail-card">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

export function KeyValue(props: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className={`rail-kv ${props.tone ?? ""}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

/** 分支树：按 parent 聚合后 DFS 展开为带缩进的行 */
export function BranchTree(props: {
  branches: SessionBranch[];
  currentBranchId: string;
  busy: boolean;
  onSwitch: (branchId: string) => void;
}) {
  const rows: Array<{ branch: SessionBranch; depth: number }> =
    [];
  const byParent = new Map<string | null, SessionBranch[]>();
  for (const branch of props.branches) {
    const siblings = byParent.get(branch.parent) ?? [];
    siblings.push(branch);
    byParent.set(branch.parent, siblings);
  }
  const walk = (parentId: string | null, depth: number) => {
    const siblings = (byParent.get(parentId) ?? []).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (const branch of siblings) {
      rows.push({ branch, depth });
      walk(branch.id, depth + 1);
    }
  };
  walk(null, 0);
  return (
    <div className="branch-tree">
      {rows.map(({ branch, depth }) => {
        const isCurrent = branch.id === props.currentBranchId;
        const forkInfo =
          branch.forkSeq !== null ? `@#${branch.forkSeq}` : "";
        return (
          <button
            key={branch.id}
            className={`branch-node ${isCurrent ? "current" : ""}`}
            style={{ paddingLeft: 10 + depth * 16 }}
            disabled={props.busy || isCurrent}
            onClick={() => props.onSwitch(branch.id)}
            title={
              isCurrent
                ? "当前分支"
                : props.busy
                  ? "任务运行中，本轮结束后可切换"
                  : "点击切换到此分支"
            }
          >
            <span className="branch-dot">{isCurrent ? "◉" : "○"}</span>
            <span className="branch-id">#{branch.id}</span>
            {branch.label && (
              <span className="branch-label">{branch.label}</span>
            )}
            {forkInfo && (
              <span className="branch-fork">{forkInfo}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
