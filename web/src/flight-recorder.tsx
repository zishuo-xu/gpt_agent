import { useEffect, useState, type ReactNode } from "react";
import type { SessionSummary } from "@shared/types.js";

type TraceTool = { call?: { tool?: string; target?: string }; permission?: string; ms?: number; result?: unknown };
type Trace = {
  version?: number; turn?: number; turnId?: string; branchId?: string; ts?: string;
  startedAt?: string; endedAt?: string; durationMs?: number; eventSeqStart?: number; eventSeqEnd?: number;
  modelRole?: string; providerId?: string; model?: string; usage?: { input?: number; output?: number; cached?: number };
  request?: unknown; response?: unknown; tools?: TraceTool[]; canFork?: boolean;
};
type Diff = {
  model?: { parent?: string; child?: string; changed?: boolean };
  overlay?: { parent?: string; child?: string; changed?: boolean };
  turns?: { parent?: number; child?: number; delta?: number };
  durationMs?: { parent?: number; child?: number; delta?: number };
  tools?: { parent?: number; child?: number; parentSequence?: string[]; childSequence?: string[]; firstDivergence?: { index?: number; parent?: { key?: string }; child?: { key?: string } } };
  tokens?: { parent?: Record<string, number>; child?: Record<string, number>; delta?: Record<string, number> };
  costCny?: { parent?: number; child?: number; delta?: number };
  status?: { parent?: string; child?: string };
  acceptance?: { parent?: unknown; child?: unknown };
  review?: { parent?: unknown; child?: unknown };
};

function url(path: string, project: string) {
  return `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(project)}`;
}
function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? ""; } catch { return String(value); }
}
function metric(value: unknown): string { return typeof value === "number" ? value.toLocaleString() : "—"; }

export function FlightRecorder(props: {
  session: SessionSummary;
  project: string;
  conversation: ReactNode;
  onSelectSession: (id: string) => void;
}) {
  const [tab, setTab] = useState<"conversation" | "trace" | "compare">("conversation");
  const [traces, setTraces] = useState<Trace[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<Trace | null>(null);
  const [raw, setRaw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [forkTrace, setForkTrace] = useState<Trace | null>(null);
  const [forkError, setForkError] = useState("");
  const [forking, setForking] = useState(false);
  const [forkResult, setForkResult] = useState<{
    sessionId: string;
    path?: string;
    head?: string;
    warnings: string[];
  } | null>(null);
  const [forkForm, setForkForm] = useState({ providerId: "", model: "", overlay: "", continuation: "" });
  const [diff, setDiff] = useState<Diff | null>(null);
  const [diffError, setDiffError] = useState("");
  const isExperiment = Boolean(props.session.experiment);

  async function loadTraces() {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch(url(`/api/sessions/${props.session.id}/traces`, props.project));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Trace 加载失败");
      setTraces((payload.traces ?? []) as Trace[]);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Trace 加载失败");
    } finally { setLoading(false); }
  }
  async function openTrace(trace: Trace, view = "redacted") {
    if (!trace.turnId) return;
    try {
      const response = await fetch(url(`/api/sessions/${props.session.id}/traces/${encodeURIComponent(trace.turnId)}?view=${view}`, props.project));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Trace 详情加载失败");
      setLoadError("");
      setSelectedTrace(payload.trace as Trace);
      setRaw(view === "raw");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Trace 详情加载失败");
    }
  }
  async function loadDiff() {
    setDiff(null);
    setDiffError("");
    try {
      const response = await fetch(url(`/api/sessions/${props.session.id}/diff`, props.project));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Run Diff 加载失败");
      setDiff((payload.comparison?.diff ?? null) as Diff | null);
    } catch (error) {
      setDiffError(error instanceof Error ? error.message : "Run Diff 加载失败");
    }
  }
  useEffect(() => {
    setTab("conversation");
    setTraces([]);
    setSelectedTrace(null);
    setRaw(false);
    setDiff(null);
    setForkTrace(null);
    setForkResult(null);
    setLoadError("");
    setDiffError("");
  }, [props.session.id]);
  useEffect(() => {
    if (tab === "trace") void loadTraces();
    if (tab === "compare" && isExperiment) void loadDiff();
  }, [tab, props.session.id]);

  function beginFork(trace: Trace) {
    setForkError("");
    setForkForm({ providerId: trace.providerId ?? "", model: trace.model ?? "", overlay: "", continuation: "" });
    setForkResult(null);
    setForkTrace(trace);
  }
  async function submitFork() {
    if (!forkTrace?.turnId || !forkForm.continuation.trim()) return;
    setForkError("");
    setForking(true);
    try {
      const response = await fetch(url(`/api/sessions/${props.session.id}/forks`, props.project), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId: forkTrace.turnId, providerId: forkForm.providerId, model: forkForm.model, systemPromptOverlay: forkForm.overlay, continuation: forkForm.continuation }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setForkError(payload.error ?? "创建实验失败"); return; }
      if (!payload.session?.id) {
        setForkError("实验已创建，但响应缺少子会话 ID");
        return;
      }
      const warnings = Array.isArray(payload.workspace?.warnings)
        ? payload.workspace.warnings.filter((item: unknown): item is string => typeof item === "string")
        : [];
      setForkResult({
        sessionId: payload.session.id,
        ...(typeof payload.workspace?.path === "string" ? { path: payload.workspace.path } : {}),
        ...(typeof payload.workspace?.head === "string" ? { head: payload.workspace.head } : {}),
        warnings,
      });
    } catch (error) {
      setForkError(error instanceof Error ? error.message : "创建实验失败");
    } finally {
      setForking(false);
    }
  }

  return <section className="flight-recorder">
    <nav className="flight-tabs" aria-label="会话视图">
      <button className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")}>对话</button>
      <button className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}>Trace</button>
      <button className={tab === "compare" ? "active" : ""} onClick={() => setTab("compare")} disabled={!isExperiment}>对比</button>
    </nav>
    {tab === "conversation" ? props.conversation : tab === "trace" ? <TraceView traces={traces} selected={selectedTrace} loading={loading} error={loadError} raw={raw} onOpen={openTrace} onFork={beginFork} /> : <DiffView diff={diff} error={diffError} />}
    {forkTrace && <ForkModal form={forkForm} error={forkError} forking={forking} result={forkResult} onChange={(key, value) => setForkForm((current) => ({ ...current, [key]: value }))} onCancel={() => setForkTrace(null)} onOpenChild={(id) => { setForkTrace(null); props.onSelectSession(id); }} onSubmit={() => void submitFork()} />}
  </section>;
}

function TraceView(props: { traces: Trace[]; selected: Trace | null; loading: boolean; error: string; raw: boolean; onOpen: (trace: Trace, view?: string) => void; onFork: (trace: Trace) => void }) {
  return <div className="flight-panel">
    <div className="flight-heading"><div><h2>Model Turn Trace</h2><p>按需加载完整请求；默认内容已递归脱敏。</p></div><span>{props.traces.length} turns</span></div>
    {props.loading && <p className="flight-muted">正在读取 Trace…</p>}
    {props.error && <div className="notice error">{props.error}</div>}
    <div className="trace-list">{props.traces.map((trace) => <article className="trace-card" key={trace.turnId ?? trace.turn}>
      <div className="trace-card-head"><strong>Turn {trace.turn ?? "—"}</strong><span>{trace.providerId}/{trace.model}</span><span>{trace.durationMs != null ? `${trace.durationMs} ms` : "—"}</span><button onClick={() => props.onOpen(trace)}>{props.selected?.turnId === trace.turnId ? "刷新详情" : "查看详情"}</button>{trace.canFork && <button onClick={() => props.onFork(trace)}>从这里 Fork</button>}</div>
      <div className="trace-metrics"><span>Token {metric((trace.usage?.input ?? 0) + (trace.usage?.output ?? 0))}</span><span>工具 {trace.tools?.length ?? 0}</span><span>事件 {trace.eventSeqStart ?? "—"}–{trace.eventSeqEnd ?? "—"}</span><span>{trace.modelRole ?? "legacy"}</span></div>
      {props.selected?.turnId === trace.turnId && props.selected && <TraceDetail trace={props.selected} raw={props.raw} onRaw={() => props.onOpen(trace, "raw")} />}
    </article>)}</div>
    {!props.traces.length && !props.loading && <p className="flight-muted">暂无可查看的 Model Turn。</p>}
  </div>;
}

function TraceDetail({ trace, raw, onRaw }: { trace: Trace; raw: boolean; onRaw: () => void }) {
  return <div className="trace-detail">
    {!raw && <div className="flight-warning">已显示脱敏内容。原文可能包含 Key、Token、Cookie、密码或环境变量，仅在明确点击后请求。</div>}
    <button className="raw-button" onClick={onRaw}>{raw ? "已显示原文" : "查看原文"}</button>
    <details open><summary>System / Messages</summary><pre>{pretty(trace.request)}</pre></details>
    <details open><summary>Response</summary><pre>{pretty(trace.response)}</pre></details>
    <details open><summary>Tools ({trace.tools?.length ?? 0})</summary>{trace.tools?.map((tool, index) => <div className="trace-tool" key={index}><code>{tool.call?.tool ?? "tool"} {tool.call?.target ?? ""}</code><span>{tool.permission ?? "—"} · {tool.ms ?? "—"} ms</span>{tool.result !== undefined && <pre>{pretty(tool.result)}</pre>}</div>)}</details>
  </div>;
}

function DiffView({ diff, error }: { diff: Diff | null; error: string }) {
  if (error) return <div className="flight-panel"><div className="notice error">{error}</div></div>;
  if (!diff) return <div className="flight-panel"><p className="flight-muted">正在读取父子 Run 对比…</p></div>;
  const row = (label: string, parent: unknown, child: unknown, delta?: unknown) => <div className="diff-row"><strong>{label}</strong><span>父 {typeof parent === "string" ? parent || "—" : metric(parent)}</span><span>子 {typeof child === "string" ? child || "—" : metric(child)}</span>{delta !== undefined && <span>Δ {metric(delta)}</span>}</div>;
  return <div className="flight-panel"><div className="flight-heading"><div><h2>Run Diff</h2><p>按规范化 tool + target 序列定位首个行为分歧。</p></div></div><div className="diff-grid">
    {row("模型", diff.model?.parent, diff.model?.child)}{row("Overlay", diff.overlay?.parent, diff.overlay?.child)}{row("Turns", diff.turns?.parent, diff.turns?.child, diff.turns?.delta)}{row("耗时 ms", diff.durationMs?.parent, diff.durationMs?.child, diff.durationMs?.delta)}
    {row("Tools", diff.tools?.parent, diff.tools?.child)}{row("Input tokens", diff.tokens?.parent?.input, diff.tokens?.child?.input, diff.tokens?.delta?.input)}{row("Output tokens", diff.tokens?.parent?.output, diff.tokens?.child?.output, diff.tokens?.delta?.output)}{row("费用 CNY", diff.costCny?.parent, diff.costCny?.child, diff.costCny?.delta)}{row("状态", diff.status?.parent, diff.status?.child)}
    <div className="diff-sequence"><strong>工具序列</strong><code>父：{diff.tools?.parentSequence?.join(" → ") || "—"}</code><code>子：{diff.tools?.childSequence?.join(" → ") || "—"}</code>{diff.tools?.firstDivergence && <mark>首个分歧：第 {((diff.tools.firstDivergence.index ?? 0) + 1)} 项</mark>}</div>
    <div className="diff-evidence"><strong>Acceptance / Review</strong><pre>{pretty({ acceptance: diff.acceptance, review: diff.review })}</pre></div>
  </div></div>;
}

function ForkModal(props: { form: { providerId: string; model: string; overlay: string; continuation: string }; error: string; forking: boolean; result: { sessionId: string; path?: string; head?: string; warnings: string[] } | null; onChange: (key: "providerId" | "model" | "overlay" | "continuation", value: string) => void; onCancel: () => void; onOpenChild: (id: string) => void; onSubmit: () => void }) {
  return <div className="flight-modal-backdrop" role="presentation"><form className="flight-modal" role="dialog" aria-label="Fork 并运行实验" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}><h2>Fork 并运行实验</h2><p className="flight-warning">快照取 Fork 创建时的当前项目状态，不是历史文件时光机。子会话将在隔离 Git worktree 中运行；ignored 文件、依赖目录、submodule 工作内容和符号链接不会自动复制。</p>{props.result ? <div className="fork-result"><strong>实验已启动</strong>{props.result.path && <code>{props.result.path}</code>}{props.result.head && <span>HEAD {props.result.head}</span>}{props.result.warnings.length > 0 ? <><p>快照警告</p><ul>{props.result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></> : <p>快照未报告额外警告。</p>}<div className="flight-modal-actions"><button type="button" onClick={() => props.onOpenChild(props.result!.sessionId)}>打开子会话</button></div></div> : <><label>Provider<input value={props.form.providerId} onChange={(event) => props.onChange("providerId", event.target.value)} required /></label><label>Model<input value={props.form.model} onChange={(event) => props.onChange("model", event.target.value)} required /></label><label>System Prompt Overlay<textarea value={props.form.overlay} onChange={(event) => props.onChange("overlay", event.target.value)} placeholder="追加到内置 System Prompt 后" /></label><label>继续指令<textarea value={props.form.continuation} onChange={(event) => props.onChange("continuation", event.target.value)} required placeholder="允许输入普通消息或 /run" /></label>{props.error && <div className="notice error">{props.error}</div>}<div className="flight-modal-actions"><button type="button" onClick={props.onCancel}>取消</button><button type="submit" disabled={props.forking}>{props.forking ? "正在创建…" : "Fork 并运行"}</button></div></>}</form></div>;
}
