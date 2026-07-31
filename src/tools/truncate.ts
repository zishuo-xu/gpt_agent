export interface TruncateOptions {
  maxLines?: number;
  maxChars?: number;
  continuationHint?: string;
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  omittedLines: number;
}

export function truncateToolText(
  value: string,
  options: TruncateOptions = {},
): TruncatedText {
  const maxLines = options.maxLines ?? 256;
  const maxChars = options.maxChars ?? 30_000;
  const lines = value.split(/\r?\n/);
  if (lines.length <= maxLines && value.length <= maxChars) {
    return { text: value, truncated: false, omittedLines: 0 };
  }

  const headBudget = Math.floor(maxChars * 0.58);
  const tailBudget = Math.floor(maxChars * 0.32);
  const headLines: string[] = [];
  const tailLines: string[] = [];
  let headChars = 0;
  let tailChars = 0;
  const lineBudget = Math.max(2, maxLines - 1);
  const headLineBudget = Math.ceil(lineBudget * 0.6);
  const tailLineBudget = lineBudget - headLineBudget;

  for (
    let index = 0;
    index < lines.length && headLines.length < headLineBudget;
    index += 1
  ) {
    const line = lines[index] ?? "";
    if (headChars + line.length + 1 > headBudget) break;
    headLines.push(line);
    headChars += line.length + 1;
  }
  for (
    let index = lines.length - 1;
    index >= headLines.length && tailLines.length < tailLineBudget;
    index -= 1
  ) {
    const line = lines[index] ?? "";
    if (tailChars + line.length + 1 > tailBudget) break;
    tailLines.unshift(line);
    tailChars += line.length + 1;
  }
  if (headLines.length === 0 && value.length > 0) {
    headLines.push(value.slice(0, headBudget));
  }
  if (
    tailLines.length === 0 &&
    value.length > headLines.join("\n").length
  ) {
    tailLines.push(value.slice(-tailBudget));
  }
  const omittedLines = Math.max(
    0,
    lines.length - headLines.length - tailLines.length,
  );
  const omittedLabel =
    omittedLines > 0 ? `${omittedLines} lines` : "middle content";
  const marker =
    `[... ${omittedLabel} truncated` +
    `${options.continuationHint ? `; ${options.continuationHint}` : ""} ...]`;
  return {
    text: [...headLines, marker, ...tailLines].join("\n"),
    truncated: true,
    omittedLines,
  };
}
