import { Fragment, createElement, useState, type ReactNode } from "react";

/** 块级 markdown 轻量渲染（自研：标题/列表/引用/分隔线/fenced code block） */
export function RichText(props: { text: string }) {
  const lines = props.text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  // fenced code block 状态：```lang 开行进入收集，闭合围栏渲染为 <pre>
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];
  const flushCode = (key: number) => {
    if (!inCode) return;
    blocks.push(
      <pre
        className="code-block"
        data-lang={codeLang}
        key={`code-${key}`}
      >
        {codeLines.map((line, lineIndex) => (
          <span key={lineIndex}>
            {line || " "}
            {"\n"}
          </span>
        ))}
      </pre>,
    );
    codeLang = "";
    codeLines = [];
    inCode = false;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();
    const fence = /^```(\S*)\s*$/.exec(trimmed);
    if (fence) {
      if (inCode) {
        flushCode(blocks.length);
      } else {
        inCode = true;
        codeLang = fence[1] ?? "";
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!trimmed) {
      blocks.push(<br key={index} />);
      continue;
    }
    // markdown 标题：## 等原样渲染为分级标题（h1 过大映射 h2，最多 h4）
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(Math.max(heading[1]!.length, 2), 4);
      blocks.push(
        createElement(
          `h${level}`,
          { key: index },
          renderInline(heading[2] ?? ""),
        ),
      );
      continue;
    }
    // 引用块
    if (trimmed.startsWith(">")) {
      blocks.push(
        <blockquote key={index}>
          {renderInline(trimmed.replace(/^>\s?/, ""))}
        </blockquote>,
      );
      continue;
    }
    // 分隔线
    if (/^-{3,}$/.test(trimmed)) {
      blocks.push(<hr key={index} />);
      continue;
    }
    // 有序列表：保留编号前缀
    const ordered = /^(\d+[.)])\s+(.*)$/.exec(trimmed);
    if (ordered) {
      blocks.push(
        <p className="rich-list-line ordered" key={index}>
          {ordered[1]} {renderInline(ordered[2] ?? "")}
        </p>,
      );
      continue;
    }
    const isList = /^[-*]\s+/.test(trimmed);
    blocks.push(
      <p className={isList ? "rich-list-line" : ""} key={index}>
        {isList ? "• " : ""}
        {renderInline(
          isList ? trimmed.replace(/^[-*]\s+/, "") : line,
        )}
      </p>,
    );
  }
  flushCode(blocks.length);
  return <div className="rich-text">{blocks}</div>;
}

export function renderInline(text: string): ReactNode[] {
  // 链接优先于 code/bold 解析：避免 [text](url) 中括号内容被误判
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^)\n]+\))/g);
  return tokens.map((token, index) => {
    if (token.startsWith("`") && token.endsWith("`")) {
      return <code key={index}>{token.slice(1, -1)}</code>;
    }
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/.exec(token);
    if (link) {
      const href = link[2] ?? "";
      // 只放行 http(s) 链接，防 javascript: 等危险协议
      return /^https?:\/\//i.test(href) ? (
        <a key={index} href={href} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>
      ) : (
        <Fragment key={index}>{token}</Fragment>
      );
    }
    return <Fragment key={index}>{token}</Fragment>;
  });
}

/** 工具输出/差异渲染：detect diff 着色 + 长输出按需展开 */
export function DiffOrOutput(props: { text: string; forceDiff?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const lines = props.text.split(/\r?\n/);
  // 同时存在 +/- 行（或带 diff 头）才按 diff 渲染，避免缩进文本误判；
  // 编辑类工具（Edit/Write/MultiEdit）输出强制按 diff 着色（纯新增文件只有 + 行）
  const hasMarker = lines.some(
    (line) => line.startsWith("@@") || line.startsWith("diff --git"),
  );
  const hasAdd = lines.some((line) => line.startsWith("+"));
  const hasRemove = lines.some((line) => line.startsWith("-"));
  const isDiff =
    props.forceDiff === true || hasMarker || (hasAdd && hasRemove);
  // 长输出按需展开：默认只展示前 60 行，避免大段输出拖慢消息流渲染
  const collapseThreshold = 60;
  const collapsed = !expanded && lines.length > collapseThreshold;
  const visibleLines = collapsed
    ? lines.slice(0, collapseThreshold)
    : lines;
  return (
    <>
      <pre className={isDiff ? "diff-output" : "tool-output"}>
        {visibleLines.map((line, index) => (
          <span
            className={
              line.startsWith("@@") || line.startsWith("diff --git")
                ? "diff-hunk"
                : line.startsWith("+")
                  ? "diff-add"
                  : line.startsWith("-")
                    ? "diff-remove"
                    : "diff-context"
            }
            key={index}
          >
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
      {collapsed && (
        <button
          className="output-expand-toggle"
          onClick={() => setExpanded(true)}
        >
          展开剩余 {lines.length - collapseThreshold} 行
        </button>
      )}
    </>
  );
}
