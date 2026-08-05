import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export interface EditJournalEntry {
  path: string;
  beforeHash: string;
  afterHash: string;
  beforeContent: string | null;
}

function hash(content: string | null): string {
  return createHash("sha256").update(content ?? "<missing>").digest("hex");
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicReplace(
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      const original = await stat(filePath);
      await chmod(tempPath, original.mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    assertNotAborted(signal);
    await rename(tempPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export class EditJournal {
  readonly #entries: EditJournalEntry[] = [];

  record(entry: EditJournalEntry): void {
    this.#entries.push(entry);
  }

  entries(): readonly EditJournalEntry[] {
    return this.#entries;
  }

  async rollbackLast(signal?: AbortSignal): Promise<boolean> {
    const entry = this.#entries.at(-1);
    if (!entry) return false;
    const current = await readOptional(entry.path);
    if (hash(current) !== entry.afterHash) return false;
    assertNotAborted(signal);
    if (entry.beforeContent === null) {
      await unlink(entry.path);
    } else {
      await atomicReplace(entry.path, entry.beforeContent, signal);
    }
    this.#entries.pop();
    return true;
  }
}

export class AtomicFileTools {
  readonly #readSet = new Set<string>();
  readonly journal: EditJournal;

  constructor(journal = new EditJournal()) {
    this.journal = journal;
  }

  async read(filePath: string, signal?: AbortSignal): Promise<string> {
    assertNotAborted(signal);
    const content = await readFile(filePath, "utf8");
    this.#readSet.add(path.resolve(filePath));
    return content;
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
    signal?: AbortSignal,
  ): Promise<string> {
    this.#assertRead(filePath);
    const before = await readFile(filePath, "utf8");
    const after = applyEdit(before, oldString, newString, replaceAll);
    await this.#commit(filePath, before, after, signal);
    return createDiffPreview(filePath, before, after);
  }

  async previewEdit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<string> {
    this.#assertRead(filePath);
    const before = await readFile(filePath, "utf8");
    const after = applyEdit(before, oldString, newString, replaceAll);
    return createDiffPreview(filePath, before, after);
  }

  async multiEdit(
    filePath: string,
    edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>,
    signal?: AbortSignal,
  ): Promise<string> {
    this.#assertRead(filePath);
    const before = await readFile(filePath, "utf8");
    const after = applyMultiEdit(before, edits);
    await this.#commit(filePath, before, after, signal);
    return createDiffPreview(filePath, before, after);
  }

  async previewMultiEdit(
    filePath: string,
    edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>,
  ): Promise<string> {
    this.#assertRead(filePath);
    const before = await readFile(filePath, "utf8");
    return createDiffPreview(
      filePath,
      before,
      applyMultiEdit(before, edits),
    );
  }

  async write(
    filePath: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const before = await readOptional(filePath);
    if (before !== null) this.#assertRead(filePath);
    const preview =
      before === null
        ? createNewFilePreview(filePath, content)
        : createDiffPreview(filePath, before, content);
    await atomicReplace(filePath, content, signal);
    this.journal.record({
      path: filePath,
      beforeHash: hash(before),
      afterHash: hash(content),
      beforeContent: before,
    });
    this.#readSet.add(path.resolve(filePath));
    return preview;
  }

  async previewWrite(filePath: string, content: string): Promise<string> {
    const before = await readOptional(filePath);
    if (before === null) {
      return createNewFilePreview(filePath, content);
    }
    this.#assertRead(filePath);
    return createDiffPreview(filePath, before, content);
  }

  #assertRead(filePath: string): void {
    if (!this.#readSet.has(path.resolve(filePath))) {
      throw new Error(`必须先 Read 文件：${filePath}`);
    }
  }

  async #commit(
    filePath: string,
    before: string,
    after: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await atomicReplace(filePath, after, signal);
    this.journal.record({
      path: filePath,
      beforeHash: hash(before),
      afterHash: hash(after),
      beforeContent: before,
    });
    this.#readSet.add(path.resolve(filePath));
  }
}

function createNewFilePreview(
  filePath: string,
  content: string,
): string {
  const lines = content.split(/\r?\n/);
  const preview = lines.slice(0, 20).map((line) => `+${line}`);
  if (lines.length > 20) {
    preview.push(`[... 其余 ${lines.length - 20} 行已折叠 ...]`);
  }
  return [
    `新建 ${filePath}（${lines.length} 行）`,
    ...preview,
  ].join("\n");
}

function applyEdit(
  before: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  const occurrences = before.split(oldString).length - 1;
  if (occurrences === 0) throw new Error("old_string 未找到");
  if (!replaceAll && occurrences !== 1) {
    throw new Error(
      `old_string 匹配 ${occurrences} 处，必须提供唯一上下文`,
    );
  }
  return replaceAll
    ? before.split(oldString).join(newString)
    : before.replace(oldString, newString);
}

function applyMultiEdit(
  before: string,
  edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>,
): string {
  let after = before;
  for (const edit of edits) {
    const occurrences = after.split(edit.old_string).length - 1;
    if (occurrences === 0) {
      throw new Error("MultiEdit 中的 old_string 未找到");
    }
    if (!edit.replace_all && occurrences !== 1) {
      throw new Error(
        `MultiEdit 中的 old_string 匹配 ${occurrences} 处`,
      );
    }
    after = edit.replace_all
      ? after.split(edit.old_string).join(edit.new_string)
      : after.replace(edit.old_string, edit.new_string);
  }
  return after;
}

function createDiffPreview(
  filePath: string,
  before: string,
  after: string,
): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const contextStart = Math.max(0, prefix - 3);
  const beforeEnd = beforeLines.length - suffix;
  const afterEnd = afterLines.length - suffix;
  const contextEndAfter = Math.min(afterLines.length, afterEnd + 3);
  const removed = beforeLines.slice(prefix, beforeEnd);
  const added = afterLines.slice(prefix, afterEnd);
  const body = [
    ...beforeLines.slice(contextStart, prefix).map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...afterLines
      .slice(afterEnd, contextEndAfter)
      .map((line) => ` ${line}`),
  ];
  const changedLines = removed.length + added.length;
  const visibleBody =
    changedLines > 50 && body.length > 56
      ? [
          ...body.slice(0, 28),
          `[... 大改动中间 ${body.length - 56} 行已折叠 ...]`,
          ...body.slice(-28),
        ]
      : body;
  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...visibleBody,
  ].join("\n");
}
