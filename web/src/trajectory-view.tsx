import { useMemo, useState } from "react";
import type { SessionEvent } from "./session-display";

/**
 * 轨迹表格（任务统计面板内"每个任务点开一个表格"）：
 * 一次会话的步骤明细表——每行一个步骤（时间 / 来源 / 内容摘要），
 * 点击行展开该步骤的完整详情（工具参数、推理文本、子代理任务等）。
 * 数据来自 GET /api/sessions/:id/events（一次性），无需 SSE。
 */

type Lane = "message" | "thinking" | "tool" | "subtask" | "system";

const LANE_LABELS: Record<Lane, string> = {
  message: "对话",
  thinking: "推理",
  tool: "工具",
  subtask: "子代理",
  system: "系统",
};

/** 步骤行：来源 + 时间 + 展示内容 */
export interface TrajectoryRow {
  lane: Lane;
  seq: number;
  ts: string;
  title: string;
  detail: string;
}

function laneOf(event: SessionEvent["event"]): Lane | null {
  switch (event.type) {
    case "user":
      return "message";
    case "thinking_delta":
      return "thinking";
    case "tool_call":
      return "tool";
    case "task_start":
      return "subtask";
    case "text_delta":
    case "tool_result":
    case "task_end":
      return null; // 文本并入对话行/配对用，不单独成行
    default:
      return "system";
  }
}

function titleOf(event: SessionEvent["event"]): string {
  switch (event.type) {
    case "user":
      return event.text.slice(0, 60);
    case "thinking_delta":
      return "推理过程";
    case "tool_call": {
      const args = JSON.stringify(event.call.args ?? {});
      return `${event.call.tool} ${event.call.target}${args.length > 80 ? "…" : ""}`;
    }
    case "task_start":
      return event.description;
    default:
      return event.type;
  }
}

function detailOf(event: SessionEvent["event"]): string {
  switch (event.type) {
    case "user":
      return event.text;
    case "thinking_delta":
      return event.text;
    case "tool_call": {
      const args = JSON.stringify(event.call.args ?? {}, null, 2);
      return `${event.call.tool}\n目标：${event.call.target}\n参数：\n${args}`;
    }
    case "task_start":
      return `子代理任务：${event.description}`;
    default:
      return JSON.stringify(event, null, 2);
  }
}

/** 事件流 → 步骤行：连续 thinking/text 增量按回合合并为单个步骤，
    工具调用配对 tool_result 展示结果（输出/diff），子代理在调用点成行 */
export function buildTrajectoryRows(events: SessionEvent[]): TrajectoryRow[] {
  // 预收集 tool_result（by callId）：结果文本进工具行详情
  const toolResults = new Map<
    string,
    { summary?: string; output?: unknown; diff?: string }
  >();
  for (const record of events) {
    const event = record.event;
    if (event.type !== "tool_result") continue;
    const details = (event.details ?? {}) as Record<string, unknown>;
    toolResults.set(event.callId, {
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.output === undefined ? {} : { output: event.output }),
      ...(typeof details.diff === "string" ? { diff: details.diff } : {}),
    });
  }
  const rows: TrajectoryRow[] = [];
  let pending:
    | {
        lane: "thinking" | "message";
        ts: string;
        seq: number;
        texts: string[];
      }
    | undefined;
  const flush = (): void => {
    if (!pending) return;
    const texts = pending.texts.join("");
    rows.push({
      lane: pending.lane,
      seq: pending.seq,
      ts: pending.ts,
      title:
        pending.lane === "thinking"
          ? "推理过程"
          : `回复：${texts.slice(0, 40)}${texts.length > 40 ? "…" : ""}`,
      detail: texts,
    });
    pending = undefined;
  };
  for (const record of events) {
    const event = record.event;
    if (event.type === "thinking_delta" || event.type === "text_delta") {
      const lane =
        event.type === "thinking_delta" ? "thinking" : "message";
      if (pending && pending.lane === lane) {
        pending.texts.push(event.text);
      } else {
        flush();
        pending = {
          lane,
          ts: record.ts,
          seq: record.seq,
          texts: [event.text],
        };
      }
      continue;
    }
    flush();
    if (event.type === "tool_call") {
      const result = toolResults.get(event.call.id);
      rows.push({
        lane: "tool",
        seq: record.seq,
        ts: record.ts,
        title: titleOf(event),
        detail: toolDetail(event, result),
      });
      continue;
    }
    const lane = laneOf(event);
    if (!lane) continue;
    rows.push({
      lane,
      seq: record.seq,
      ts: record.ts,
      title: titleOf(event),
      detail: detailOf(event),
    });
  }
  flush();
  return rows;
}

/** 工具行详情：参数 + 结果（diff 优先，其次输出/摘要；长输出截断） */
function toolDetail(
  event: Extract<SessionEvent["event"], { type: "tool_call" }>,
  result:
    | { summary?: string; output?: unknown; diff?: string }
    | undefined,
): string {
  const args = JSON.stringify(event.call.args ?? {}, null, 2);
  const parts = [
    `${event.call.tool}`,
    `目标：${event.call.target}`,
    `参数：\n${args}`,
  ];
  if (result) {
    const outputText =
      typeof result.output === "string"
        ? result.output
        : result.output === undefined
          ? undefined
          : JSON.stringify(result.output, null, 2);
    const resultText =
      result.diff ?? outputText ?? result.summary ?? "";
    parts.push(
      `结果：\n${resultText.length > 3000 ? `${resultText.slice(0, 3000)}\n[… 结果过长已截断 …]` : resultText}`,
    );
  } else {
    parts.push("结果：（无返回——工具被拒绝或事件流不完整）");
  }
  return parts.join("\n\n");
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function TrajectoryTable(props: {
  events: SessionEvent[];
  onClose: () => void;
}) {
  const rows = useMemo(
    () => buildTrajectoryRows(props.events),
    [props.events],
  );
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="trajectory-table">
      <div className="trajectory-table-header">
        <span>步骤明细</span>
        <code>{rows.length} 个步骤</code>
        <button onClick={props.onClose}>关闭</button>
      </div>
      <div className="trajectory-table-scroll">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>来源</th>
              <th>内容</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <FragmentRow
                key={row.seq}
                row={row}
                expanded={expanded === row.seq}
                onToggle={() =>
                  setExpanded(expanded === row.seq ? null : row.seq)
                }
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="trajectory-table-empty">该会话暂无步骤事件。</p>
        )}
      </div>
    </div>
  );
}

function FragmentRow(props: {
  row: TrajectoryRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { row } = props;
  return (
    <>
      <tr
        className={`trajectory-row lane-${row.lane}${
          props.expanded ? " expanded" : ""
        }`}
        onClick={props.onToggle}
      >
        <td className="trajectory-cell-time">{formatTime(row.ts)}</td>
        <td className="trajectory-cell-lane">
          <span className={`lane-dot lane-${row.lane}`} />
          {LANE_LABELS[row.lane]}
        </td>
        <td className="trajectory-cell-title">{row.title}</td>
      </tr>
      {props.expanded && (
        <tr className="trajectory-row-detail">
          <td colSpan={3}>
            <pre>{row.detail}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
