import { readFile } from "node:fs/promises";
import path from "node:path";
import { collectFiles } from "../tools/collect-files.js";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".sh",
]);

const MAX_FILES = 500;
const MAX_MAP_CHARS = 8000;

interface FileSignature {
  path: string;
  signatures: string[];
}

export class RepoMap {
  readonly #cwd: string;
  #cache: string | null = null;
  #cacheTime = 0;
  static readonly CACHE_TTL_MS = 60_000;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  async get(): Promise<string> {
    const now = Date.now();
    if (this.#cache !== null && now - this.#cacheTime < RepoMap.CACHE_TTL_MS) {
      return this.#cache;
    }
    // 复用统一文件收集（git ls-files + gitignore 语义，深度上限 8 与原遍历一致）
    const files = await collectFiles(this.#cwd, { maxDepth: 8 });
    const signatures: FileSignature[] = [];
    let sourceFiles = 0;
    for (const file of files) {
      if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue;
      if (sourceFiles >= MAX_FILES) break;
      sourceFiles += 1;
      const sigs = await this.#extractSignatures(file);
      if (sigs.length > 0) {
        signatures.push({
          path: path.relative(this.#cwd, file),
          signatures: sigs,
        });
      }
    }
    this.#cache = this.#format(signatures);
    this.#cacheTime = now;
    return this.#cache;
  }

  async #extractSignatures(filePath: string): Promise<string[]> {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return [];
    }
    if (content.length > 200_000) content = content.slice(0, 200_000);
    const ext = path.extname(filePath);
    const lines = content.split(/\r?\n/);
    const signatures: string[] = [];
    for (const line of lines) {
      const sig = extractLineSignature(line, ext);
      if (sig) signatures.push(sig);
      if (signatures.length >= 30) break;
    }
    return signatures;
  }

  #format(signatures: FileSignature[]): string {
    const lines: string[] = [];
    for (const file of signatures) {
      lines.push(`${file.path}:`);
      for (const sig of file.signatures) {
        lines.push(`  ${sig}`);
      }
    }
    let result = lines.join("\n");
    if (result.length > MAX_MAP_CHARS) {
      result =
        result.slice(0, MAX_MAP_CHARS) +
        "\n[... 仓库地图已截断，使用 Glob/Grep 探索更多 ...]";
    }
    return result;
  }
}

function extractLineSignature(line: string, ext: string): string | null {
  const trimmed = line.trim();
  if (
    !trimmed ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  ) {
    return null;
  }

  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    let m = trimmed.match(
      /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    );
    if (m) return `class ${m[1]!}`;
    m = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
    if (m) return `interface ${m[1]!}`;
    m = trimmed.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
    if (m) return `type ${m[1]!}`;
    m = trimmed.match(
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
    );
    if (m) return `fn ${m[1]!}(${cleanParams(m[2])})`;
    m = trimmed.match(
      /^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*[^=]+)?\s*=>/,
    );
    if (m) return `fn ${m[1]!}(${cleanParams(m[2])})`;
    m = trimmed.match(
      /^(?:public|private|protected|static|async|readonly|\s)*(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{/,
    );
    if (m && m[1] === "constructor")
      return `constructor(${cleanParams(m[2])})`;
    if (
      m &&
      !["if", "for", "while", "switch", "catch"].includes(m[1]!)
    ) {
      return `method ${m[1]!}(${cleanParams(m[2])})`;
    }
    return null;
  }

  if (ext === ".py") {
    let m = trimmed.match(/^class\s+(\w+)/);
    if (m) return `class ${m[1]!}`;
    m = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
    if (m) return `fn ${m[1]!}(${cleanParams(m[2])})`;
    return null;
  }

  if (ext === ".go") {
    let m = trimmed.match(/^type\s+(\w+)\s+(?:struct|interface)/);
    if (m) return `type ${m[1]!}`;
    m = trimmed.match(
      /^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)/,
    );
    if (m) {
      const receiver = m[2] ? `(${m[2]}).` : "";
      return `fn ${receiver}${m[3]!}(${cleanParams(m[4])})`;
    }
    return null;
  }

  if (ext === ".rs") {
    let m = trimmed.match(
      /^(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/,
    );
    if (m) return `type ${m[1]!}`;
    m = trimmed.match(
      /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/,
    );
    if (m) return `fn ${m[1]!}(${cleanParams(m[2])})`;
    return null;
  }

  if ([".java", ".kt", ".scala"].includes(ext)) {
    let m = trimmed.match(
      /^(?:public|private|protected)?\s*(?:abstract\s+)?(?:class|interface|object)\s+(\w+)/,
    );
    if (m) return `class ${m[1]!}`;
    m = trimmed.match(
      /^(?:public|private|protected|static|final|abstract|synchronized|\s)*(\w+)\s+(\w+)\s*\(([^)]*)\)/,
    );
    if (
      m &&
      !["if", "for", "while", "switch", "catch", "return", "new"].includes(
        m[1]!,
      )
    ) {
      return `method ${m[2]!}(${cleanParams(m[3])})`;
    }
    return null;
  }

  if ([".c", ".cpp", ".h", ".hpp"].includes(ext)) {
    let m = trimmed.match(/^(?:class|struct)\s+(\w+)/);
    if (m) return `class ${m[1]!}`;
    m = trimmed.match(
      /^(?:[\w:*&<>\s]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:const)?\s*[;{]/,
    );
    if (
      m &&
      !["if", "for", "while", "switch", "catch", "return"].includes(m[1]!)
    ) {
      return `fn ${m[1]!}(${cleanParams(m[2])})`;
    }
    return null;
  }

  if (ext === ".rb") {
    let m = trimmed.match(/^class\s+(\w+)/);
    if (m) return `class ${m[1]!}`;
    m = trimmed.match(/^def\s+(\w+[!?=]?)\s*(?:\(([^)]*)\))?/);
    if (m) return `fn ${m[1]!}(${cleanParams(m[2])})`;
    return null;
  }

  return null;
}

function cleanParams(params: string | undefined): string {
  if (!params || !params.trim()) return "";
  return params
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const name = (p.split(/[:\s=]/)[0] ?? "").replace(/[&*]/g, "");
      return name;
    })
    .filter(Boolean)
    .join(", ");
}
