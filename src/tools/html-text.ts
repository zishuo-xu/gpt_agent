/**
 * 无依赖 HTML → 可见文本提取器（WebFetch 示例插件使用）。
 * 覆盖常见网页结构：剥离 script/style/noscript、注释、标签与实体，
 * 块级元素换行，空白归一。不做完整 DOM 解析（无浏览器环境），
 * 对 table/复杂嵌套的保真度有限——够阅读型抓取即可。
 */

const BLOCK_TAGS =
  /\s*<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre|header|footer|nav|aside|br|hr)>/gi;

/** 去 script/style/noscript 块与注释（非贪婪，支持跨行） */
function stripHiddenBlocks(html: string): string {
  return html.replace(
    /<(script|style|noscript|template|svg)[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi,
    "",
  );
}

/** 剥离导航/页眉/页脚/侧栏/表单块（内容倾向提取：抓取正文时跳过站点 chrome） */
function stripChrome(html: string): string {
  return html.replace(
    /<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
}

/** 标签替换为换行或删除，保留实体原样 */
function stripTags(html: string): string {
  // 块级闭合标签 → 换行（配对 <div>...</div> 的闭合处）
  let text = html.replace(BLOCK_TAGS, "\n");
  // 自闭合块级（<br>、<hr>）→ 换行
  text = text.replace(/<(br|hr)\b[^>]*\/?>/gi, "\n");
  // 其余标签全部剥离（保留标签间文本）
  text = text.replace(/<[^>]*>/g, "");
  return text;
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};

/** 实体解码：命名字典 + 十进制/十六进制数字实体 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
      }
      return ENTITY_MAP[body.toLowerCase()] ?? match;
    },
  );
}

/** 空白归一：行内连续空白压为单空格，行首尾去空白，空行合并（阅读型紧凑文本） */
function normalizeWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string): string {
  return normalizeWhitespace(decodeEntities(stripTags(stripHiddenBlocks(html))));
}

/**
 * 内容倾向提取：在 htmlToText 基础上额外剥离 nav/header/footer/aside/form 块
 * （导航菜单、页眉页脚、侧栏是抓取正文的主要噪音来源）。
 * 供 WebFetch / WebSearch 深度模式抓取正文使用；htmlToText 保持通用语义不变。
 */
export function htmlToMainText(html: string): string {
  return normalizeWhitespace(
    decodeEntities(stripTags(stripHiddenBlocks(stripChrome(html)))),
  );
}
