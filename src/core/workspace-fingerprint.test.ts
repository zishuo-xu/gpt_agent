import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  captureWorkspaceFingerprint,
  isWorkspaceFingerprint,
  workspaceFingerprintKey,
} from "./workspace-fingerprint.js";

const execFile = promisify(execFileCb);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}

async function repo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-fingerprint-"));
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Test");
  await writeFile(path.join(cwd, "tracked.txt"), "base\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "initial");
  return cwd;
}

test("fingerprint is stable for an unchanged tree and changes when dirty", async () => {
  const cwd = await repo();
  const first = await captureWorkspaceFingerprint(cwd);
  const second = await captureWorkspaceFingerprint(cwd);
  assert.ok(isWorkspaceFingerprint(first));
  assert.equal(workspaceFingerprintKey(first!), workspaceFingerprintKey(second!));
  await writeFile(path.join(cwd, "tracked.txt"), "changed\n");
  const dirty = await captureWorkspaceFingerprint(cwd);
  assert.ok(isWorkspaceFingerprint(dirty));
  assert.equal(dirty!.head, first!.head);
  assert.notEqual(dirty!.dirty, first!.dirty);
});

test("non-git directories return undefined instead of throwing", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-nongit-fp-"));
  assert.equal(await captureWorkspaceFingerprint(cwd), undefined);
});
