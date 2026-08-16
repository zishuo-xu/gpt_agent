import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * CLI 黑盒测试：spawn 真实 CLI 进程（隔离 HOME 与 cwd），管道输入命令，
 * 断言交互输出。覆盖命令分发主路径：/help、/trust、/model、/config、/exit。
 * 不依赖模型配置——启动与命令处理均不发起模型请求。
 */
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
// tsx 包 CLI 入口的绝对路径（cwd 是隔离的项目目录，相对解析不可用）
const tsxCli = require.resolve("tsx/cli");

async function runCli(
  commands: string[],
  cwd: string,
  home: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, path.join(repoRoot, "src/cli.ts")],
      {
        cwd,
        env: { ...process.env, HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI 启动或交互超时（60s）"));
    }, 60_000);
    child.stdin.write(commands.join("\n"));
    child.stdin.end();
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timeout);
      resolve(output);
    });
  });
}

async function makeEnv(): Promise<{ cwd: string; home: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-cli-test-"));
  const cwd = path.join(root, "proj");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  return { cwd, home };
}

test("CLI 启动：/help 列出命令清单（含 /trust 与信任项目说明）", async () => {
  const { cwd, home } = await makeEnv();
  const output = await runCli(["/help", "/exit"], cwd, home);
  assert.match(output, /myagent ›/);
  assert.match(output, /\/trust\s+将当前目录标记为信任项目/);
  assert.match(output, /\/model/);
  assert.match(output, /\/config/);
});

test("CLI /trust：标记当前目录，二次调用提示已在列表", async () => {
  const { cwd, home } = await makeEnv();
  const first = await runCli(["/trust", "/exit"], cwd, home);
  assert.match(first, /已将当前目录标记为信任项目/);
  // 全局配置已持久化（HOME 隔离的 ~/.myagent/config.jsonc）
  const configPath = path.join(home, ".myagent", "config.jsonc");
  const configText = await readFile(configPath, "utf8");
  assert.match(configText, /trustedProjects/);
  assert.match(configText, /proj/);
  // 二次调用：已在列表
  const second = await runCli(["/trust", "/exit"], cwd, home);
  assert.match(second, /已在信任项目列表/);
});

test("CLI /model：展示三角色模型配置", async () => {
  const { cwd, home } = await makeEnv();
  const output = await runCli(["/model", "/exit"], cwd, home);
  assert.match(output, /角色模型：main=.*cheap=.*explore=/);
  assert.match(output, /用法：\/model main <providerId>\/<model>/);
});

test("CLI /config：展示生效配置摘要（权限档与角色模型）", async () => {
  const { cwd, home } = await makeEnv();
  const output = await runCli(["/config", "/exit"], cwd, home);
  assert.match(output, /权限档：normal/);
  assert.match(output, /角色模型：main=/);
});

test("CLI 未知命令提示 /help", async () => {
  const { cwd, home } = await makeEnv();
  const output = await runCli(["/不存在的命令", "/exit"], cwd, home);
  assert.match(output, /未知命令：\/不存在的命令/);
  assert.match(output, /输入 \/help 查看可用命令/);
});

test("CLI /undo：无可撤销编辑时给出明确提示", async () => {
  const { cwd, home } = await makeEnv();
  const output = await runCli(["/undo", "/exit"], cwd, home);
  assert.match(output, /没有可撤销的编辑记录/);
});
