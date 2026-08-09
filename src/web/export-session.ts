import type { RecordedEvent } from "../core/types.js";

/**
 * 会话导出为自包含 HTML（Pi export-html 对标）：内联样式、无外部依赖，
 * 可在任意浏览器打开回看。事件流 → 时间线列表渲染。
 */
export function exportSessionHtml(options: {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  permissionMode: string;
  records: RecordedEvent[];
}): string {
  const { sessionId, title, createdAt, updatedAt, permissionMode } = options;
  const items = options.records.map(renderRecord).join("\n");
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · MyAgent 会话导出</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #0f1115; color: #d6dae0; margin: 0; padding: 24px; line-height: 1.55; }
  .header { max-width: 860px; margin: 0 auto 24px; border-bottom: 1px solid #2a2e37; padding-bottom: 16px; }
  .header h1 { margin: 0 0 6px; font-size: 20px; }
  .header .meta { color: #8a91a0; font-size: 13px; }
  .timeline { max-width: 860px; margin: 0 auto; display: grid; gap: 10px; }
  .event { border: 1px solid #262b34; border-radius: 10px; padding: 10px 14px; background: #151922; }
  .event .head { display: flex; gap: 10px; align-items: baseline; font-size: 12px; color: #7d8594; margin-bottom: 4px; }
  .event .seq { color: #566071; font-variant-numeric: tabular-nums; }
  .event.user { border-left: 3px solid #3b82f6; }
  .event.assistant { border-left: 3px solid #10b981; }
  .event.tool { border-left: 3px solid #8b5cf6; }
  .event.system { border-left: 3px solid #6b7280; opacity: 0.8; }
  .event.error { border-left: 3px solid #ef4444; }
  .event.thinking { border-left: 3px solid #64748b; opacity: 0.75; }
  .thinking-label { font-size: 11px; letter-spacing: 0.08em; color: #94a3b8; }
  .event .body { font-size: 14px; white-space: pre-wrap; word-break: break-word; }
  .event .body code { background: #1c212b; padding: 1px 6px; border-radius: 4px; font-size: 13px; }
  .event .label { font-size: 12px; color: #f2c94c; margin-left: 8px; }
  pre.diff { background: #0b0e13; border: 1px solid #262b34; border-radius: 6px; padding: 8px 10px; overflow-x: auto; font-size: 12px; }
  pre.diff .add { color: #6ee7a0; }
  pre.diff .del { color: #fda4a4; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; background: #232936; color: #9aa4b5; }
</style>
</head>
<body>
<div class="header">
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">
    会话 #${escapeHtml(sessionId)} · ${escapeHtml(permissionMode)} 档 · 创建 ${escapeHtml(createdAt)} · 更新 ${escapeHtml(updatedAt)}
  </div>
</div>
<div class="timeline">
${items}
</div>
</body>
</html>`;
}

function renderRecord(record: RecordedEvent): string {
  const event = record.event;
  const seq = record.seq;
  const ts = record.ts.slice(0, 19).replace("T", " ");
  switch (event.type) {
    case "user": {
      const label = event.queueId
        ? `<span class="label">已排队</span>`
        : "";
      return item(
        "user",
        seq,
        ts,
        `👤 ${escapeHtml(event.text)}${label}`,
      );
    }
    case "user_queued": {
      const mode = event.steer ? "插队" : "排队";
      return item(
        "user",
        seq,
        ts,
        `👤 ${escapeHtml(event.text)}<span class="label">${mode}</span>`,
      );
    }
    case "text_delta":
      return item("assistant", seq, ts, escapeHtml(event.text));
    case "thinking_delta":
      return item(
        "thinking",
        seq,
        ts,
        `<span class="thinking-label">思考过程</span>\n${escapeHtml(event.text)}`,
      );
    case "tool_call": {
      const args = JSON.stringify(event.call.args ?? {}, null, 2);
      return item(
        "tool",
        seq,
        ts,
        `🔧 <b>${escapeHtml(event.call.tool)}</b> ${escapeHtml(
          event.call.target ?? "",
        )}\n<code>${escapeHtml(args)}</code>`,
      );
    }
    case "tool_result": {
      const summary =
        typeof event.summary === "string"
          ? event.summary
          : JSON.stringify(event.summary);
      const diff = event.details as
        | { diff?: string }
        | undefined;
      const diffHtml = diff?.diff
        ? `<pre class="diff">${highlightDiff(diff.diff)}</pre>`
        : "";
      const tone = event.isError ? "error" : "tool";
      return item(
        tone,
        seq,
        ts,
        `↩ ${escapeHtml(summary.slice(0, 500))}${diffHtml}`,
      );
    }
    case "ask_permission":
      return item(
        "tool",
        seq,
        ts,
        `⚠️ 审批请求：<b>${escapeHtml(event.call.tool)}</b> ${escapeHtml(
          event.call.target ?? "",
        )}\n${escapeHtml(event.risk)}`,
      );
    case "todo_update": {
      const todos = event.todos
        .map(
          (todo) =>
            `${todo.status === "completed" ? "✅" : todo.status === "in_progress" ? "🔄" : "⬜"} ${escapeHtml(todo.content)}`,
        )
        .join("\n");
      return item("system", seq, ts, `📋 任务清单\n${todos}`);
    }
    case "cost_update":
      return item(
        "system",
        seq,
        ts,
        `💰 本轮 ${event.input} in / ${event.output} out / 缓存 ${event.cached} · 累计 ${event.totalTokens} tokens`,
      );
    case "done":
      return item("system", seq, ts, "🏁 任务完成");
    case "need_user":
      return item("system", seq, ts, `🤔 ${escapeHtml(event.question)}`);
    case "error":
      return item("error", seq, ts, `❌ ${escapeHtml(event.message)}`);
    case "run_started":
      return item(
        "system",
        seq,
        ts,
        `🚀 无人值守任务：${escapeHtml(event.description)}`,
      );
    case "run_finished":
      return item(
        "system",
        seq,
        ts,
        `🏁 任务结束（${event.status}${event.reason ? ` · ${event.reason}` : ""}）`,
      );
    case "context_compacted":
      return item(
        "system",
        seq,
        ts,
        `📦 上下文已压缩（保留 ${event.keepFromSeq ?? "?"} 起）`,
      );
    case "label":
      return event.name
        ? item("system", seq, ts, `🔖 书签 #${event.seq}「${escapeHtml(event.name)}」`)
        : item("system", seq, ts, `🗑 移除书签 #${event.seq}`);
    case "notify":
      return item(
        event.level === "error" ? "error" : "system",
        seq,
        ts,
        `🔔 ${escapeHtml(event.message)}`,
      );
    case "permission_mode_changed":
      return item("system", seq, ts, `⚙️ 权限档 → ${escapeHtml(event.mode)}`);
    case "branch_switch":
      return item("system", seq, ts, `🌿 切换分支 #${escapeHtml(event.branchId)}`);
    default:
      return item("system", seq, ts, escapeHtml(JSON.stringify(event).slice(0, 300)));
  }
}

function item(
  kind: string,
  seq: number,
  ts: string,
  bodyHtml: string,
): string {
  return `<div class="event ${kind}">
  <div class="head"><span class="seq">#${seq}</span><span>${escapeHtml(ts)}</span></div>
  <div class="body">${bodyHtml}</div>
</div>`;
}

function highlightDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return `<span class="add">${escapeHtml(line)}</span>`;
      if (line.startsWith("-")) return `<span class="del">${escapeHtml(line)}</span>`;
      return escapeHtml(line);
    })
    .join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
