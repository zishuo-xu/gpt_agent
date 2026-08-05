import { escapeRegExp } from "./regexp.js";
import path from "node:path";

/** 统一分隔符为 `/`（glob 匹配与相对路径比较用） */
export function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

/** glob → 正则（支持 `**` 通配、`*`、`?`；`[` 字符集等透传） */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (
      character === "*" &&
      pattern[index + 1] === "*" &&
      pattern[index + 2] === "/"
    ) {
      source += "(?:.*/)?";
      index += 2;
    } else if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character ?? "");
    }
  }
  return new RegExp(`^${source}$`);
}
