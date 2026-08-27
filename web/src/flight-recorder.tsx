import { useEffect, useState, type ReactNode } from "react";
import type { SessionSummary } from "@shared/types.js";

type TraceTool = { call?: { tool?: string; target?: string }; permission?: string; ms?: number; result?: unknown };
type Observation = {
  saw?: { messages?: number; lastUser?: string };
  decided?: { text?: string; tools?: string[] };
  did?: Array<{ tool?: string; target?: string; permission?: string; outcome?: string }>;
};
type Trace = {
  version?: number; turn?: number; turnId?: string; branchId?: string; ts?: string;
  startedAt?: string; endedAt?: string; durationMs?: number; eventSeqStart?: number; eventSeqEnd?: number;
  modelRole?: string; providerId?: string; model?: string; usage?: { input?: number; output?: number; cached?: number };
  request?: unknown; response?: unknown; tools?: TraceTool[]; canFork?: boolean;
  observation?: Observation;
  workspace?: { head?: string; dirty?: string };
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
  workspace?: { comparable?: boolean; changed?: boolean };
  isolation?: { isolatable?: boolean; changedKnobs?: string[]; reasons?: string[] };
  observation?: { parent?: Observation; child?: Observation };
};

function url(path: string, project: string) {
  return `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(project)}`;
}
function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? ""; } catch { return String(value); }
}
function metric(value: unknown): string { return typeof value === "number" ? value.toLocaleString() : "—"; }

function isSameTrace(left: Trace | null, right: Trace): boolean {
  if (!left) return false;
  if (left.turnId && right.turnId) return left.turnId === right.turnId;
  if (left.turnId || right.turnId) return false;
  return left.turn === right.turn;
}

const ROLE_LABEL: Record<string, string> = { main: "主模型", cheap: "压缩", explore: "探索" };
const KNOB_LABEL: Record<string, string> = { model: "模型", overlay: "Overlay", workspace: "工作区" };
const ISOLATION_REASON: Record<string, string> = {
  multiple_knobs: "同时改了模型和 Overlay，不能当成单变量对照",
  workspace_drift: "工作区指纹不一致，不能当成对照",
  missing_fingerprint: "缺少工作区指纹（旧 Trace 或非 Git），不能声称可隔离",
};

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
      const detail = payload.trace as Trace;
      setSelectedTrace({
        ...detail,
        observation: payload.observation ?? detail.observation ?? trace.observation,
        workspace: detail.workspace ?? trace.workspace,
      });
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
    if (!forkTrace?.turnId) return;
    if (!forkForm.continuation.trim()) {
      setForkError("继续指令不能为空");
      return;
    }
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
      <button
        className={tab === "compare" ? "active" : ""}
        onClick={() => setTab("compare")}
        disabled={!isExperiment}
        title={isExperiment ? "对照这次实验和父 Run" : "从 Trace 创建实验后才能对照"}
      >对比</button>
    </nav>
    {tab === "conversation" ? props.conversation : tab === "trace" ? <TraceView traces={traces} selected={selectedTrace} loading={loading} error={loadError} raw={raw} onOpen={openTrace} onFork={beginFork} forkBlocked={props.project === "lobby" ? "大厅没有 Git 仓库，不能创建对照实验" : undefined} /> : <DiffView diff={diff} error={diffError} />}
    {forkTrace && <ForkModal form={forkForm} error={forkError} forking={forking} result={forkResult} onChange={(key, value) => setForkForm((current) => ({ ...current, [key]: value }))} onCancel={() => setForkTrace(null)} onOpenChild={(id) => { setForkTrace(null); props.onSelectSession(id); }} onSubmit={() => void submitFork()} />}
  </section>;
}

function TraceView(props: { traces: Trace[]; selected: Trace | null; loading: boolean; error: string; raw: boolean; onOpen: (trace: Trace, view?: string) => void; onFork: (trace: Trace) => void; forkBlocked?: string }) {
  return <div className="flight-panel">
    <div className="flight-heading">
      <div>
        <h2>Turn 观测</h2>
        <p>每个 Turn 先看它看见了什么、决定做什么、实际做了什么。详情默认脱敏。</p>
      </div>
      <span>{props.traces.length} turns</span>
    </div>
    {props.loading && <p className="flight-muted">正在读取 Trace…</p>}
    {props.error && <div className="notice error">{props.error}</div>}
    <div className="trace-list">{props.traces.map((trace) => {
      const open = isSameTrace(props.selected, trace);
      return <article className={`trace-card${open ? " selected" : ""}`} key={trace.turnId ?? `turn-${trace.turn}`}>
        <div className="trace-card-head">
          <div className="trace-identity">
            <strong>Turn {trace.turn ?? "—"}</strong>
            <span className="trace-role">{ROLE_LABEL[trace.modelRole ?? ""] ?? (trace.turnId ? (trace.modelRole ?? "未知") : "旧记录")}</span>
            <span className="trace-model">{trace.providerId && trace.model ? `${trace.providerId}/${trace.model}` : "模型未记录"}</span>
          </div>
          <div className="trace-actions">
            {trace.turnId
              ? <button type="button" onClick={() => props.onOpen(trace)}>{open ? "刷新详情" : "查看详情"}</button>
              : <span className="trace-legacy" title="旧 Trace 没有 turnId，只能看读法，不能展开原文或 Fork">旧记录</span>}
            {trace.canFork && (props.forkBlocked
              ? <span className="trace-legacy" title={props.forkBlocked}>大厅不能 Fork</span>
              : <button type="button" className="fork-button" onClick={() => props.onFork(trace)}>从这里 Fork</button>)}
          </div>
        </div>
        <div className="trace-metrics">
          <span>Token {metric((trace.usage?.input ?? 0) + (trace.usage?.output ?? 0))}</span>
          <span>工具 {trace.tools?.length ?? 0}</span>
          <span>耗时 {trace.durationMs != null ? `${trace.durationMs} ms` : "—"}</span>
          {trace.workspace?.head && <span title={trace.workspace.head}>工作区 {trace.workspace.head.slice(0, 8)}</span>}
        </div>
        {trace.observation && <TurnReadout observation={trace.observation} />}
        {open && props.selected && <TraceDetail trace={props.selected} raw={props.raw} onRaw={() => props.onOpen(trace, "raw")} />}
      </article>;
    })}</div>
    {!props.traces.length && !props.loading && <div className="flight-empty">这一轮还没有 Model Turn。对话跑起来之后，这里会按 Turn 列出观测。</div>}
  </div>;
}

function IsolationBanner({ isolation, workspace }: { isolation?: Diff["isolation"]; workspace?: Diff["workspace"] }) {
  if (!isolation) return null;
  const knobs = isolation.changedKnobs ?? [];
  const reasons = (isolation.reasons ?? []).map((reason) => ISOLATION_REASON[reason] ?? reason);
  const workspaceLabel = !workspace || workspace.comparable === false
    ? "未知"
    : workspace.changed
      ? "已漂移"
      : "一致";
  return <section className={`diff-verdict ${isolation.isolatable ? "ok" : "blocked"}`}>
    <div className="diff-verdict-copy">
      <strong>{isolation.isolatable ? "可以对照" : "隔离失败，只展示事实，不下结论"}</strong>
      <p>{isolation.isolatable
        ? (knobs.length === 1 ? `仅 ${KNOB_LABEL[knobs[0] ?? ""] ?? knobs[0]} 改变。下面的分叉只作为事实。` : "旋钮未变。下面的分叉只作为事实，不归因到原因。")
        : reasons.join("；")}</p>
    </div>
    <div className="diff-knobs" aria-label="对照旋钮">
      <span className={`diff-knob${knobs.includes("model") ? " changed" : ""}`}>模型{knobs.includes("model") ? " · 变了" : " · 相同"}</span>
      <span className={`diff-knob${knobs.includes("overlay") ? " changed" : ""}`}>Overlay{knobs.includes("overlay") ? " · 变了" : " · 相同"}</span>
      <span className={`diff-knob${workspaceLabel === "已漂移" || workspaceLabel === "未知" ? " changed" : ""}`}>工作区 · {workspaceLabel}</span>
    </div>
  </section>;
}

function TurnReadout({ observation }: { observation: Observation }) {
  const decided = observation.decided?.tools?.length
    ? observation.decided.tools
    : observation.decided?.text
      ? [observation.decided.text]
      : [];
  const did = observation.did?.filter((step) => step.tool) ?? [];
  return <div className="trace-observe" aria-label="Turn 读法">
    <div className="observe-step">
      <strong>看见</strong>
      <p>{observation.saw?.lastUser || (observation.saw?.messages ? `${observation.saw.messages} 条消息` : "这一轮没有用户原文")}</p>
    </div>
    <div className="observe-step">
      <strong>决定</strong>
      {decided.length
        ? <div className="observe-chips">{decided.map((item) => <span key={item}>{item}</span>)}</div>
        : <p>没有工具意图</p>}
    </div>
    <div className="observe-step">
      <strong>做了</strong>
      {did.length
        ? <div className="observe-chips">{did.map((step, index) => <span key={`${step.tool}-${step.target}-${index}`} title={`结果：${outcomeLabel(step.outcome)}`}>{[step.tool, step.target].filter(Boolean).join(" ")} · {outcomeLabel(step.outcome)}</span>)}</div>
        : <p>没有工具落地</p>}
    </div>
  </div>;
}

function outcomeLabel(outcome?: string): string {
  return ({ success: "成功", error: "错误", denied: "拒绝", aborted: "中断", unknown: "未知" } as Record<string, string>)[outcome ?? "unknown"] ?? "未知";
}

function TraceDetail({ trace, raw, onRaw }: { trace: Trace; raw: boolean; onRaw: () => void }) {
  return <div className="trace-detail">
    {!raw && <div className="flight-warning">已显示脱敏内容。原文可能包含 Key、Token、Cookie、密码或环境变量，仅在明确点击后请求。</div>}
    <button className="raw-button" onClick={onRaw}>{raw ? "已显示原文" : "查看原文"}</button>
    <details><summary>请求上下文</summary><pre>{pretty(trace.request)}</pre></details>
    <details><summary>模型响应</summary><pre>{pretty(trace.response)}</pre></details>
    <details open><summary>工具阶段（{trace.tools?.length ?? 0}）</summary>{trace.tools?.length
      ? trace.tools.map((tool, index) => <div className="trace-tool" key={index}><code>{tool.call?.tool ?? "tool"} {tool.call?.target ?? ""}</code><span>{tool.permission ?? "—"} · {tool.ms ?? "—"} ms</span>{tool.result !== undefined && <pre>{pretty(tool.result)}</pre>}</div>)
      : <p className="flight-muted">这一轮没有工具阶段。</p>}</details>
  </div>;
}

function sequenceParts(key: string): { tool: string; target: string } {
  const index = key.indexOf("+");
  if (index < 0) return { tool: key, target: "" };
  return { tool: key.slice(0, index), target: key.slice(index + 1) };
}

function SequenceLane(props: { label: string; steps: string[]; divergeAt?: number }) {
  return <div className="diff-lane">
    <h3>{props.label}</h3>
    {props.steps.length === 0
      ? <p className="flight-muted">没有工具调用</p>
      : <ol>{props.steps.map((key, index) => {
        const { tool, target } = sequenceParts(key);
        return <li key={`${key}-${index}`} className={index === props.divergeAt ? "diverged" : undefined}>
          <span className="seq-index">{index + 1}</span>
          <span className="seq-tool">{tool}</span>
          {target && <code>{target}</code>}
        </li>;
      })}</ol>}
  </div>;
}

function DiffView({ diff, error }: { diff: Diff | null; error: string }) {
  if (error) return <div className="flight-panel"><div className="notice error">{error}</div></div>;
  if (!diff) return <div className="flight-panel"><p className="flight-muted">正在读取父子 Run 对比…</p></div>;
  const divergeAt = diff.tools?.firstDivergence?.index;
  const row = (label: string, parent: unknown, child: unknown, delta?: unknown) => <div className="diff-row"><strong>{label}</strong><span>父 {typeof parent === "string" ? parent || "—" : metric(parent)}</span><span>子 {typeof child === "string" ? child || "—" : metric(child)}</span>{delta !== undefined && <span>Δ {metric(delta)}</span>}</div>;
  return <div className="flight-panel">
    <div className="flight-heading">
      <div>
        <h2>对照</h2>
        <p>先看能不能隔离，再看工具序列。隔离失败时只展示事实。</p>
      </div>
    </div>
    <IsolationBanner isolation={diff.isolation} workspace={diff.workspace} />
    {(diff.observation?.parent || diff.observation?.child) && <div className="diff-sequence">
      <div className="diff-sequence-head"><strong>Turn 读法</strong></div>
      <div className="diff-lanes">
        <div className="diff-lane">
          <h3>父 Run</h3>
          {diff.observation?.parent
            ? <TurnReadout observation={diff.observation.parent} />
            : <p className="flight-muted">Fork 点没有可对照的父 Turn</p>}
        </div>
        <div className="diff-lane">
          <h3>子 Run</h3>
          {diff.observation?.child
            ? <TurnReadout observation={diff.observation.child} />
            : <p className="flight-muted">子会话还没有 Model Turn</p>}
        </div>
      </div>
    </div>}
    <div className="diff-sequence">
      <div className="diff-sequence-head">
        <strong>工具序列（事实）</strong>
        {divergeAt !== undefined && <mark>序列分叉：第 {divergeAt + 1} 项</mark>}
      </div>
      <div className="diff-lanes">
        <SequenceLane label="父 Run" steps={diff.tools?.parentSequence ?? []} divergeAt={divergeAt} />
        <SequenceLane label="子 Run" steps={diff.tools?.childSequence ?? []} divergeAt={divergeAt} />
      </div>
    </div>
    <div className="diff-grid">
      {row("模型", diff.model?.parent, diff.model?.child)}
      {row("Overlay", diff.overlay?.parent, diff.overlay?.child)}
      {row("Turns", diff.turns?.parent, diff.turns?.child, diff.turns?.delta)}
      {row("耗时 ms", diff.durationMs?.parent, diff.durationMs?.child, diff.durationMs?.delta)}
      {row("Tools", diff.tools?.parent, diff.tools?.child)}
      {row("Input tokens", diff.tokens?.parent?.input, diff.tokens?.child?.input, diff.tokens?.delta?.input)}
      {row("Output tokens", diff.tokens?.parent?.output, diff.tokens?.child?.output, diff.tokens?.delta?.output)}
      {row("费用 CNY", diff.costCny?.parent, diff.costCny?.child, diff.costCny?.delta)}
      {row("状态", diff.status?.parent, diff.status?.child)}
    </div>
    {(diff.acceptance || diff.review) && <div className="diff-evidence"><strong>Acceptance / Review</strong><pre>{pretty({ acceptance: diff.acceptance, review: diff.review })}</pre></div>}
  </div>;
}

function ForkModal(props: { form: { providerId: string; model: string; overlay: string; continuation: string }; error: string; forking: boolean; result: { sessionId: string; path?: string; head?: string; warnings: string[] } | null; onChange: (key: "providerId" | "model" | "overlay" | "continuation", value: string) => void; onCancel: () => void; onOpenChild: (id: string) => void; onSubmit: () => void }) {
  return <div className="flight-modal-backdrop" role="presentation"><form className="flight-modal" role="dialog" aria-label="Fork 并运行实验" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}><h2>Fork 并运行实验</h2><p className="flight-warning">快照取 Fork 创建时的当前项目状态，不是历史文件时光机。子会话将在隔离 Git worktree 中运行；ignored 文件、依赖目录、submodule 工作内容和符号链接不会自动复制。</p>{props.result ? <div className="fork-result"><strong>实验已启动</strong>{props.result.path && <code>{props.result.path}</code>}{props.result.head && <span>HEAD {props.result.head}</span>}{props.result.warnings.length > 0 ? <><p>快照警告</p><ul>{props.result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></> : <p>快照未报告额外警告。</p>}<div className="flight-modal-actions"><button type="button" onClick={() => props.onOpenChild(props.result!.sessionId)}>打开子会话</button></div></div> : <><label>Provider<input value={props.form.providerId} onChange={(event) => props.onChange("providerId", event.target.value)} required /></label><label>Model<input value={props.form.model} onChange={(event) => props.onChange("model", event.target.value)} required /></label><label>System Prompt Overlay<textarea value={props.form.overlay} onChange={(event) => props.onChange("overlay", event.target.value)} placeholder="只改这一项，更容易对照" /></label><label>继续指令<textarea value={props.form.continuation} onChange={(event) => props.onChange("continuation", event.target.value)} required placeholder="普通消息或 /run" /></label>{props.error && <div className="notice error">{props.error}</div>}<div className="flight-modal-actions"><button type="button" onClick={props.onCancel}>取消</button><button type="submit" disabled={props.forking || !props.form.continuation.trim()}>{props.forking ? "正在创建…" : "Fork 并运行"}</button></div></>}</form></div>;
}
