import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigService, ConfigValidationError } from "./service.js";
import { CONFIG_SCHEMA } from "./schema.js";

async function fixture(): Promise<ConfigService> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-config-"));
  return new ConfigService({
    cwd: path.join(root, "project"),
    homeDir: path.join(root, "home"),
  });
}

test("第三方渠道可保存，API Key 读取时不返回明文", async () => {
  const service = await fixture();
  const config = await service.readPublic("global");
  config.providers.push({
    id: "deepseek",
    name: "DeepSeek",
    enabled: true,
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "secret-key",
    hasApiKey: false,
    models: ["deepseek-chat", "deepseek-reasoner"],
  });
  config.models.explore = {
    providerId: "deepseek",
    model: "deepseek-chat",
  };

  const saved = await service.write("global", config);
  const publicConfig = await service.readPublic("global");
  assert.equal(saved.providers[1]?.apiKey, "");
  assert.equal(publicConfig.providers[1]?.apiKey, "");
  assert.equal(publicConfig.providers[1]?.hasApiKey, true);

  const raw = await readFile(service.pathFor("global"), "utf8");
  assert.match(raw, /MyAgent 本机配置/);
  assert.match(raw, /secret-key/);
});

test("API Key 留空保存时保留原值", async () => {
  const service = await fixture();
  const config = await service.readPublic("project");
  config.providers[0]!.apiKey = "first-key";
  await service.write("project", config);

  const next = await service.readPublic("project");
  next.providers[0]!.name = "Anthropic Primary";
  next.providers[0]!.apiKey = "";
  await service.write("project", next);

  const raw = await service.read("project");
  assert.equal(raw.providers[0]?.name, "Anthropic Primary");
  assert.equal(raw.providers[0]?.apiKey, "first-key");
});

test("拒绝无效 URL 与不存在的角色模型", async () => {
  const service = await fixture();
  const config = await service.readPublic("global");
  config.providers[0]!.baseUrl = "not-a-url";
  config.models.main.model = "missing-model";
  await assert.rejects(
    service.write("global", config),
    (error) =>
      error instanceof ConfigValidationError &&
      error.issues.some((issue) => issue.includes("Base URL")) &&
      error.issues.some((issue) => issue.includes("模型列表")),
  );
});

test("项目与全局批准规则写入 permissions 且保留已有配置", async () => {
  const service = await fixture();
  await service.addPermissionRule("project", {
    effect: "allow",
    pattern: "Bash(git commit *)",
  });
  await service.addPermissionRule("global", {
    effect: "deny",
    pattern: "Bash(rm -rf *)",
  });

  const project = await service.read("project");
  const global = await service.read("global");
  assert.deepEqual(project.permissions.rules, [
    { effect: "allow", pattern: "Bash(git commit *)" },
  ]);
  assert.deepEqual(global.permissions.rules, [
    { effect: "deny", pattern: "Bash(rm -rf *)" },
  ]);
  assert.equal(project.models.main.model, "claude-sonnet-4-5");

  const raw = await readFile(service.pathFor("project"), "utf8");
  assert.match(raw, /"permissions"/);
  assert.match(raw, /Bash\(git commit \*\)/);
});

test("项目层只存覆盖项，生效配置为全局与项目的深合并", async () => {
  const service = await fixture();
  const global = await service.readPublic("global");
  global.providers.push({
    id: "third-party",
    name: "Third Party",
    enabled: true,
    protocol: "openai-compatible",
    baseUrl: "https://models.example.com/v1",
    apiKey: "global-secret",
    hasApiKey: false,
    models: ["coding-model"],
  });
  global.models.main = {
    providerId: "third-party",
    model: "coding-model",
  };
  await service.write("global", global);

  await service.addPermissionRule("project", {
    effect: "allow",
    pattern: "Bash(pnpm test *)",
  });

  // 项目文件只含新增规则，不复制全局渠道与 API Key
  const raw = await readFile(service.pathFor("project"), "utf8");
  assert.match(raw, /Bash\(pnpm test \*\)/);
  assert.doesNotMatch(raw, /global-secret/);
  assert.doesNotMatch(raw, /third-party/);

  // 生效配置 = 全局模型/渠道 + 项目规则
  const effective = await service.readEffective();
  assert.equal(effective.models.main.providerId, "third-party");
  assert.equal(
    effective.providers.find((provider) => provider.id === "third-party")
      ?.apiKey,
    "global-secret",
  );
  assert.deepEqual(effective.permissions.rules, [
    { effect: "allow", pattern: "Bash(pnpm test *)" },
  ]);
});

test("生效配置拼接全局与项目两层权限规则", async () => {
  const service = await fixture();
  await service.addPermissionRule("global", {
    effect: "deny",
    pattern: "Bash(rm -rf *)",
  });
  await service.addPermissionRule("project", {
    effect: "allow",
    pattern: "Bash(pnpm test *)",
  });

  const effective = await service.readEffective();
  assert.deepEqual(effective.permissions.rules, [
    { effect: "deny", pattern: "Bash(rm -rf *)" },
    { effect: "allow", pattern: "Bash(pnpm test *)" },
  ]);
});

test("角色模型 fallback 链与各自单价可持久化", async () => {
  const service = await fixture();
  const config = await service.readPublic("global");
  config.providers.push({
    id: "backup",
    name: "Backup",
    enabled: true,
    protocol: "openai-compatible",
    baseUrl: "https://backup.example.com/v1",
    apiKey: "backup-key",
    hasApiKey: false,
    models: ["backup-model"],
  });
  config.models.main.fallbacks = [
    {
      providerId: "backup",
      model: "backup-model",
      pricing: {
        inputPerMillionCny: 2,
        outputPerMillionCny: 8,
        cachedInputPerMillionCny: 0.5,
      },
    },
  ];

  await service.write("global", config);
  const saved = await service.read("global");

  assert.equal(
    saved.models.main.fallbacks?.[0]?.model,
    "backup-model",
  );
  assert.equal(
    saved.models.main.fallbacks?.[0]?.pricing?.outputPerMillionCny,
    8,
  );
});

test("server.host 与 server.password 写入嵌套结构并可读回", async () => {
  const service = await fixture();
  const config = await service.readPublic("project");
  config.server.host = "0.0.0.0";
  config.server.password = "secret-key";
  await service.write("project", config);

  const raw = await readFile(service.pathFor("project"), "utf8");
  assert.match(raw, /"server": \{\s*"host": "0\.0\.0\.0"/s);
  const readBack = await service.read("project");
  assert.equal(readBack.server.host, "0.0.0.0");
  assert.equal(readBack.server.password, "secret-key");
});

test("Schema 新增标量字段无需修改 ConfigService 即可默认展示并持久化", async () => {
  CONFIG_SCHEMA.push({
    key: "experimentalLimit",
    type: "number",
    title: "实验上限",
    description: "用于验证 Schema 驱动设置。",
    default: 3,
    min: 1,
    hot: true,
  });
  try {
    const service = await fixture();
    const config = await service.readPublic("global");
    assert.equal(config.experimentalLimit, 3);

    config.experimentalLimit = 7;
    await service.write("global", config);

    const saved = await service.readPublic("global");
    assert.equal(saved.experimentalLimit, 7);
    const raw = await readFile(service.pathFor("global"), "utf8");
    assert.match(raw, /"experimentalLimit": 7/);
  } finally {
    CONFIG_SCHEMA.pop();
  }
});

test("未显式配价模型按内置价格表补默认，显式配置优先", async () => {
  const service = await fixture();
  // 默认配置使用内置价格（claude-sonnet / claude-haiku）
  const global = await service.read("global");
  assert.equal(global.models.main.pricing?.inputPerMillionCny, 21);
  assert.equal(global.models.cheap.pricing?.outputPerMillionCny, 35);

  // 显式配置的 pricing 不被覆盖
  global.models.main = {
    providerId: "anthropic",
    model: "claude-sonnet-4-5",
    pricing: {
      inputPerMillionCny: 99,
      outputPerMillionCny: 99,
      cachedInputPerMillionCny: 9,
    },
  };
  await service.write("global", global);
  const readBack = await service.read("global");
  assert.equal(readBack.models.main.pricing?.inputPerMillionCny, 99);

  // 未知模型不补默认价格（先加入渠道列表以通过校验）
  const provider = readBack.providers.find((p) => p.id === "anthropic");
  if (provider) provider.models.push("my-custom-model");
  readBack.models.cheap = {
    providerId: "anthropic",
    model: "my-custom-model",
  };
  await service.write("global", readBack);
  const last = await service.read("global");
  assert.equal(last.models.cheap.pricing, undefined);
});
