import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RepoMap } from "./repo-map.js";

test("RepoMap 提取 TypeScript 和 Python 签名", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-repomap-"),
  );
  await writeFile(
    path.join(cwd, "service.ts"),
    [
      "export class UserService {",
      "  constructor(private db: Database) {}",
      "  async findById(id: string): Promise<User> {",
      "    return this.db.query(id);",
      "  }",
      "}",
      "",
      "export interface Config {",
      "  port: number;",
      "}",
      "",
      "export function createApp(config: Config): App {",
      "  return new App(config);",
      "}",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cwd, "utils.py"),
    [
      "class DataProcessor:",
      "    def __init__(self, source):",
      "        self.source = source",
      "",
      "    async def process(self, batch_size):",
      "        pass",
      "",
      "def load_config(path):",
      "    return {}",
    ].join("\n"),
    "utf8",
  );

  const repoMap = new RepoMap(cwd);
  const map = await repoMap.get();

  assert.match(map, /service\.ts:/);
  assert.match(map, /class UserService/);
  assert.match(map, /interface Config/);
  assert.match(map, /fn createApp\(config\)/);
  assert.match(map, /utils\.py:/);
  assert.match(map, /class DataProcessor/);
  assert.match(map, /fn process\(self, batch_size\)/);
  assert.match(map, /fn load_config\(path\)/);
  assert.doesNotMatch(map, /return this\.db\.query/);
  assert.doesNotMatch(map, /self\.source = source/);
});

test("RepoMap 忽略 node_modules 等目录", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-repomap-ignore-"),
  );
  await mkdir(path.join(cwd, "node_modules", "pkg"), {
    recursive: true,
  });
  await writeFile(
    path.join(cwd, "node_modules", "pkg", "index.ts"),
    "export class ShouldNotAppear {}\n",
    "utf8",
  );
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "src", "main.ts"),
    "export class MainApp {}\n",
    "utf8",
  );

  const repoMap = new RepoMap(cwd);
  const map = await repoMap.get();

  assert.match(map, /class MainApp/);
  assert.doesNotMatch(map, /ShouldNotAppear/);
});

test("RepoMap 缓存与 invalidate", async () => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-repomap-cache-"),
  );
  await writeFile(
    path.join(cwd, "a.ts"),
    "export class Alpha {}\n",
    "utf8",
  );

  const repoMap = new RepoMap(cwd);
  const first = await repoMap.get();
  assert.match(first, /class Alpha/);

  await writeFile(
    path.join(cwd, "b.ts"),
    "export class Beta {}\n",
    "utf8",
  );
  const cached = await repoMap.get();
  assert.doesNotMatch(cached, /class Beta/);

  repoMap.invalidate();
  const refreshed = await repoMap.get();
  assert.match(refreshed, /class Beta/);
});
