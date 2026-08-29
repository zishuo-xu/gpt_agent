import type { DeliveryProjection, WorkspaceInfo } from "@shared/types.js";

export type DeliveryWorkbenchData = DeliveryProjection;

const outcomeLabels = { completed: "已验证完成", failed: "任务失败", interrupted: "任务中断", running: "任务运行中" } as const;
const statusLabels = { passed: "通过", failed: "未通过", not_run: "未运行", timed_out: "超时" } as const;

export function DeliveryWorkbench(props: {
  delivery: DeliveryWorkbenchData;
  workspace?: WorkspaceInfo;
  onContinue?: () => void;
  onCopyPath?: () => void;
  onExport?: () => void;
}) {
  const d = props.delivery;
  const heading = d.outcome === "completed" && d.verification === "not_run" ? "已完成但未机器验收" : d.outcome === "completed" && d.verification === "failed" ? "机器验收未通过" : outcomeLabels[d.outcome];
  return <section className="delivery-workbench delivery-summary" aria-label="交付验收">
    <header><h2>{heading}</h2><span>改动 {d.files.length} 个文件</span></header>
    <div className="delivery-sections">
      <section><h3>机器验收：{statusLabels[d.verification]}</h3>{d.checks.length ? <ul>{d.checks.map((c, i) => <li key={`${c.command}-${i}`}><code>{c.command}</code> · {statusLabels[c.status]} · {c.durationMs}ms{c.exitCode === undefined ? "" : ` · exit ${c.exitCode}`}<details><summary>输出</summary><pre>{c.output || "（无输出）"}</pre></details></li>)}</ul> : <p>未运行机器验收</p>}</section>
      <section><h3>Review：{statusLabels[d.review]}</h3>{d.reviewResult && <><p>{d.reviewResult.summary}</p>{d.reviewResult.issues.length > 0 && <ul>{d.reviewResult.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}</>}</section>
      <section><h3>改动文件（完整清单）</h3>{d.files.length ? <ul className="delivery-files">{d.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul> : <p>没有记录到成功的文件写入。</p>}</section>
      {props.workspace?.mode === "isolated" && <section><h3>隔离工作区</h3><p>{props.workspace.exists === false ? "路径缺失" : props.workspace.path}</p>{props.workspace.baseHead && <p>基线 HEAD：<code>{props.workspace.baseHead}</code></p>}{props.workspace.currentHead && <p>当前 HEAD：<code>{props.workspace.currentHead}</code></p>}{props.workspace.changedSinceCreated && <p>工作区自创建后已发生变化。</p>}{props.workspace.warnings?.map((warning) => <p key={warning}>警告：{warning}</p>)}<p>改动尚未自动合并。</p></section>}
    </div>
    {(d.unconfirmed.length || d.warnings.length) ? <aside>{[...d.unconfirmed, ...d.warnings].map((warning) => <p key={warning}>提示：{warning}</p>)}</aside> : null}
    <footer><button onClick={props.onContinue}>继续处理</button>{props.workspace?.mode === "isolated" && <button onClick={props.onCopyPath}>复制隔离路径</button>}<button onClick={props.onExport}>导出会话</button></footer>
  </section>;
}
