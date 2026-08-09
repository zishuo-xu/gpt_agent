import { useEffect, useMemo, useState } from "react";
import { SettingsSidebar } from "./SettingsSidebar";
import { DiffOrOutput } from "./session-render";
import type {
  MemoryDocument,
  MemoryDocumentId,
  MemoryTimelineEntry,
} from "@shared/types.js";

/** 某条自动写入展开的留档内容（before/after/diff） */
interface HistoryDiff {
  before: string;
  after: string;
  diff: string;
}

export function MemoryApp() {
  const [documents, setDocuments] = useState<MemoryDocument[]>([]);
  const [timeline, setTimeline] = useState<MemoryTimelineEntry[]>([]);
  const [selectedId, setSelectedId] =
    useState<MemoryDocumentId>("preferences");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<
    Record<string, HistoryDiff>
  >({});
  const [loadingHistoryKey, setLoadingHistoryKey] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const selected = useMemo(
    () => documents.find((document) => document.id === selectedId),
    [documents, selectedId],
  );

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/memory");
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "读取记忆失败");
      }
      const next = (payload.documents ?? []) as MemoryDocument[];
      setDocuments(next);
      setTimeline(payload.timeline ?? []);
      const current =
        next.find((document) => document.id === selectedId) ??
        next[0];
      if (current) {
        setSelectedId(current.id);
        setDraft(current.content);
      }
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "读取记忆失败",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    document.title = "记忆面板 · MyAgent";
    void load();
  }, []);

  // 成功提示 4 秒后自动消失
  useEffect(() => {
    if (notice?.tone !== "ok") return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (selected) setDraft(selected.content);
  }, [selectedId, selected?.content]);

  async function save(content = draft) {
    if (!selected) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/memory/${selected.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "保存失败");
      }
      setDocuments((current) =>
        current.map((document) =>
          document.id === selected.id
            ? payload.document
            : document,
        ),
      );
      setDraft(content);
      setNotice({
        tone: "ok",
        text: content ? "记忆已保存。" : "记忆文档已清空。",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "保存失败",
      });
    } finally {
      setSaving(false);
    }
  }

  /** 展开/收起某条时间线的「自动写入 diff」（按需拉取留档，不随列表下发） */
  async function toggleHistory(entry: MemoryTimelineEntry, key: string) {
    if (expandedHistory[key]) {
      setExpandedHistory((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      return;
    }
    if (!entry.historyPath) return;
    setLoadingHistoryKey(key);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/memory/history?path=${encodeURIComponent(entry.historyPath)}`,
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "读取改动失败");
      }
      setExpandedHistory((current) => ({ ...current, [key]: payload }));
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "读取改动失败",
      });
    } finally {
      setLoadingHistoryKey(null);
    }
  }

  return (
    <div className="shell">
      <SettingsSidebar active="memory" />
      <main className="memory-main">
        <header className="page-header">
          <div>
            <p className="eyebrow">AGENT / MEMORY</p>
            <h1>记忆面板</h1>
            <p>
              Agent 沉淀的长期记忆 · 可直接编辑 · 自动写入均可审计
            </p>
          </div>
          <button
            className="save-button"
            disabled={saving || loading || !selected}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存更改"}
          </button>
        </header>
        {notice && (
          <div className={`notice ${notice.tone}`}>{notice.text}</div>
        )}
        <div className="memory-workspace">
          <aside className="memory-list">
            {documents.map((document) => (
              <button
                className={`doc-${document.id}${
                  document.id === selectedId ? " selected" : ""
                }`}
                key={document.id}
                onClick={() => setSelectedId(document.id)}
              >
                <span className="doc-icon">
                  {document.scope === "global" ? "◎" : "◇"}
                </span>
                <span>
                  <strong>{document.label}</strong>
                  <small>
                    {document.content.trim()
                      ? `${document.content.split(/\r?\n/).length} 行`
                      : "空文档"}
                  </small>
                </span>
              </button>
            ))}
          </aside>
          <section className="memory-editor">
            {loading || !selected ? (
              <div className="chat-waiting">正在读取记忆…</div>
            ) : (
              <>
                <div className="memory-editor-header">
                  <div>
                    <h2>{selected.label}</h2>
                    <code>{selected.path}</code>
                  </div>
                  <button
                    className="memory-clear-button"
                    disabled={!draft}
                    onClick={() => {
                      if (
                        window.confirm(
                          `确认清空 ${selected.label}？该操作会立即影响后续会话。`,
                        )
                      ) {
                        void save("");
                      }
                    }}
                  >
                    清空文档
                  </button>
                </div>
                <textarea
                  className="memory-textarea"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={[
                    "# 稳定记忆",
                    "",
                    "- [2026-07-30] 已验证的项目约定或踩坑",
                  ].join("\n")}
                />
                <div className="memory-timeline">
                  <h3>它学到了什么</h3>
                  {timeline.filter(
                    (entry) => entry.documentId === selected.id,
                  ).length === 0 ? (
                    <p>尚无 Agent 自动写入记录。</p>
                  ) : (
                    timeline
                      .filter(
                        (entry) =>
                          entry.documentId === selected.id,
                      )
                      .map((entry, index) => {
                        const key = `${entry.sessionId}-${entry.ts}`;
                        const diff = expandedHistory[key];
                        return (
                          <div
                            className="timeline-entry"
                            key={`${entry.ts}-${index}`}
                          >
                            <time>
                              {new Intl.DateTimeFormat("zh-CN", {
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                              }).format(new Date(entry.ts))}
                              {" · "}会话 #{entry.sessionId}
                            </time>
                            <strong>{entry.sessionTitle}</strong>
                            <span>{entry.summary}</span>
                            <div className="timeline-actions">
                              {entry.historyPath ? (
                                <button
                                  className="timeline-link"
                                  disabled={loadingHistoryKey === key}
                                  onClick={() =>
                                    void toggleHistory(entry, key)
                                  }
                                >
                                  {diff
                                    ? "收起改动"
                                    : loadingHistoryKey === key
                                      ? "读取中…"
                                      : "查看改动"}
                                </button>
                              ) : (
                                <span className="timeline-hint">
                                  本次改动发生在本功能上线前，无留档可对比
                                </span>
                              )}
                              <button
                                className="timeline-link"
                                onClick={() => {
                                  window.location.hash = `#sessions/${entry.sessionId}`;
                                }}
                              >
                                打开会话
                              </button>
                            </div>
                            {diff && (
                              <DiffOrOutput
                                text={diff.diff}
                                forceDiff
                              />
                            )}
                          </div>
                        );
                      })
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
