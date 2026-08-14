import { useMemo, useState } from "react";
import type { SessionEvent } from "./session-display";

/**
 * 轨迹视图（任务统计面板内"每个任务点开"）：
 * 按回合结构化的步骤展示——每一轮完整呈现
 * 「用户输入（提示词）→ 模型推理过程 → 工具调用（参数+结果）→ 模型最终回复」。
 * 数据来自 GET /api/sessions/:id/events（一次性），无需 SSE。
 */

/** 单个回合的完整链路 */
export interface TrajectoryTurn {
  /** 回合序号（1 起） */
  index: number;
  userSeq: number;
  userTs: string;
  /** 用户输入全文（提示词） */
  userText: string;
  /** 模型推理过程（thinking_delta 按回合合并） */
  thinking?: string;
  /** 工具调用（参数 + 配对结果） */
  tools: Array<{ title: string; detail: string }>;
  /** 模型最终回复（text_delta 按回合合并） */
  reply?: string;
}

function toolResultMap(
  events: SessionEvent[],
): Map<string, { summary?: string; output?: unknown; diff?: string }> {
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
  return toolResults;
}

function toolDetail(
  tool: string,
  target: string,
  args: unknown,
  result:
    | { summary?: string; output?: unknown; diff?: string }
    | undefined,
): string {
  const parts = [
    `${tool}`,
    `目标：${target}`,
    `参数：\n${JSON.stringify(args ?? {}, null, 2)}`,
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

/** 事件流 → 回合分组：user 事件开新回合，thinking/text 增量按回合合并，
    工具调用配对 tool_result 展示结果；子代理/系统事件并入回合的附注 */
export function buildTrajectoryTurns(
  events: SessionEvent[],
): TrajectoryTurn[] {
  const toolResults = toolResultMap(events);
  const turns: TrajectoryTurn[] = [];
  let current:
    | {
        index: number;
        userSeq: number;
        userTs: string;
        userText: string;
        thinking?: string;
        tools: Array<{ title: string; detail: string }>;
        reply?: string;
      }
    | undefined;

  const startTurn = (seq: number, ts: string, text: string): void => {
    current = {
      index: turns.length + 1,
      userSeq: seq,
      userTs: ts,
      userText: text,
      tools: [],
    };
    turns.push(current);
  };

  for (const record of events) {
    const event = record.event;
    if (event.type === "user") {
      startTurn(record.seq, record.ts, event.text);
      continue;
    }
    if (!current) {
      // 无用户消息的会话（异常/恢复片段）：兜底归入一个回合
      startTurn(record.seq, record.ts, "（会话无用户消息）");
    }
    if (event.type === "thinking_delta") {
      current!.thinking = (current!.thinking ?? "") + event.text;
    } else if (event.type === "text_delta") {
      current!.reply = (current!.reply ?? "") + event.text;
    } else if (event.type === "tool_call") {
      const result = toolResults.get(event.call.id);
      const args = event.call.args ?? {};
      current!.tools.push({
        title: `${event.call.tool} ${event.call.target}`,
        detail: toolDetail(event.call.tool, event.call.target, args, result),
      });
    }
  }
  return turns;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 可折叠内容块：标题行 + 点击展开详情 */
function ExpandBlock(props: {
  label: string;
  meta?: string;
  content: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <div className={`trajectory-block-item${open ? " open" : ""}`}>
      <button
        className="trajectory-block-toggle"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="trajectory-block-caret">{open ? "▾" : "▸"}</span>
        <span className="trajectory-block-label">{props.label}</span>
        {props.meta && (
          <span className="trajectory-block-meta">{props.meta}</span>
        )}
      </button>
      {open && (
        <pre className="trajectory-block-content">{props.content}</pre>
      )}
    </div>
  );
}

export function TrajectoryTable(props: {
  events: SessionEvent[];
  onClose: () => void;
}) {
  const turns = useMemo(
    () => buildTrajectoryTurns(props.events),
    [props.events],
  );
  const toolCount = turns.reduce(
    (sum, turn) => sum + turn.tools.length,
    0,
  );

  return (
    <div className="trajectory-table">
      <div className="trajectory-table-header">
        <span>轨迹</span>
        <code>
          {turns.length} 轮 · {toolCount} 次工具调用
        </code>
        <button onClick={props.onClose}>关闭</button>
      </div>
      <div className="trajectory-table-scroll">
        {turns.map((turn) => (
          <section className="trajectory-turn" key={turn.userSeq}>
            <header className="trajectory-turn-head">
              <span className="trajectory-turn-index">#{turn.index}</span>
              <span className="trajectory-turn-title">
                {turn.userText.slice(0, 40)}
                {turn.userText.length > 40 ? "…" : ""}
              </span>
              <time>{formatTime(turn.userTs)}</time>
            </header>
            <div className="trajectory-turn-body">
              <ExpandBlock
                label="用户输入"
                content={turn.userText}
                defaultOpen
              />
              {turn.thinking && (
                <ExpandBlock label="推理过程" content={turn.thinking} />
              )}
              {turn.tools.map((tool, index) => (
                <ExpandBlock
                  key={`${turn.userSeq}-${index}`}
                  label={tool.title}
                  content={tool.detail}
                />
              ))}
              {turn.reply && (
                <ExpandBlock
                  label="模型回复"
                  content={turn.reply}
                  defaultOpen
                />
              )}
            </div>
          </section>
        ))}
        {turns.length === 0 && (
          <p className="trajectory-table-empty">该会话暂无步骤事件。</p>
        )}
      </div>
    </div>
  );
}
