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
  const verificationLabel = statusLabels[d.verification];
  const reviewLabel = statusLabels[d.review];
  // 任务还在跑：不渲染交付卡（此时它没有信息量，只是一块占位噪音）
  if (d.outcome === "running") return null;
  const summaryBits = [
    `${d.files.length} 个改动文件`,
    `机器验收 ${verificationLabel}`,
    `Review ${reviewLabel}`,
    d.warnings.length + d.unconfirmed.length > 0
      ? `${d.warnings.length + d.unconfirmed.length} 项待确认`
      : null,
  ].filter(Boolean).join(" · ");
  return <details className="delivery-workbench delivery-collapsed" aria-label="交付验收">
    <summary>
      <span className="delivery-collapsed-title">交付结果 · {heading}</span>
      <span className="delivery-collapsed-meta">{summaryBits}</span>
    </summary>
    <div className="delivery-body">
    <div className="delivery-metrics" aria-label="交付摘要">
      <div><strong>{d.files.length}</strong><span>改动文件</span></div>
      <div><strong>{verificationLabel}</strong><span>机器验收</span></div>
      <div><strong>{reviewLabel}</strong><span>Review</span></div>
      <div><strong>{d.warnings.length + d.unconfirmed.length}</strong><span>待确认事项</span></div>
    </div>
    <details className="delivery-details" aria-label="交付详情">
      <summary>查看详情（改动清单 / 验收输出 / Review）</summary>
      <div className="delivery-sections">
        <section className="delivery-section delivery-verdict"><h3>现在可以怎么判断</h3><p>{d.verification === "passed" ? "机器验收已通过，可以查看改动并继续下一步。" : d.verification === "not_run" ? "任务产出已生成，但还没有机器验收证据。" : "机器验收未通过，建议先处理失败项。"}</p>{d.reviewResult && <><p>{d.reviewResult.summary}</p>{d.reviewResult.issues.length > 0 && <ul>{d.reviewResult.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}</>}</section>
        <section className="delivery-section"><h3>改动文件</h3>{d.files.length ? <ul className="delivery-files-preview">{d.files.slice(0, 5).map((file) => <li key={file}><code>{file}</code></li>)}</ul> : <p>没有记录到成功的文件写入。</p>}{d.files.length > 5 && <p className="delivery-more">还有 {d.files.length - 5} 个文件，见完整清单。</p>}</section>
        <details className="delivery-details"><summary>查看机器验收详细输出（{d.checks.length} 项）</summary><section><h3>机器验收：{statusLabels[d.verification]}</h3>{d.checks.length ? <ul>{d.checks.map((c, i) => <li key={`${c.command}-${i}`}><code>{c.command}</code> · {statusLabels[c.status]} · {c.durationMs}ms{c.exitCode === undefined ? "" : ` · exit ${c.exitCode}`}<details><summary>输出</summary><pre>{c.output || "（无输出）"}</pre></details></li>)}</ul> : <p>未运行机器验收</p>}</section><section><h3>Review：{statusLabels[d.review]}</h3></section><section><h3>完整文件清单</h3>{d.files.length ? <ul className="delivery-files">{d.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul> : null}</section></details>
        {props.workspace?.mode === "isolated" && <section><h3>隔离工作区</h3><p>{props.workspace.exists === false ? "路径缺失" : props.workspace.path}</p>{props.workspace.baseHead && <p>基线 HEAD：<code>{props.workspace.baseHead}</code></p>}{props.workspace.currentHead && <p>当前 HEAD：<code>{props.workspace.currentHead}</code></p>}{props.workspace.changedSinceCreated && <p>工作区自创建后已发生变化。</p>}{props.workspace.warnings?.map((warning) => <p key={warning}>警告：{warning}</p>)}<p>改动尚未自动合并。</p></section>}
      </div>
      {(d.unconfirmed.length || d.warnings.length) ? <aside>{[...d.unconfirmed, ...d.warnings].map((warning) => <p key={warning}>提示：{warning}</p>)}</aside> : null}
    </details>
    <footer><button className="delivery-primary-action" onClick={props.onContinue}>继续处理</button>{props.workspace?.mode === "isolated" && <button onClick={props.onCopyPath}>复制隔离路径</button>}<button className="delivery-secondary-action" onClick={props.onExport}>导出</button></footer>
    </div>
  </details>;
}
