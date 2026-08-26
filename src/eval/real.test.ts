import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CompletionRequest, ModelClient, ModelResponse } from "../model/types.js";
import type { RoleModelConfig, ModelProviderConfig } from "../config/schema.js";
import { buildInjectedEvalOptions } from "./real.js";
import { runScenario } from "./harness.js";

/** 两回合行为的最小客户端：第一回合调 Read，第二回合给最终回复（不联网）。 */
class TwoTurnClient implements ModelClient {
  #turn = 0;

  constructor(private readonly fixturePath: string) {}

  async complete(_request: CompletionRequest): Promise<ModelResponse> {
    this.#turn += 1;
    if (this.#turn === 1) {
      return {
        text: "",
        toolCalls: [{ id: "real-1", tool: "Read", target: this.fixturePath, args: { file_path: this.fixturePath } }],
        usage: { input: 123, output: 45, cached: 0 },
        providerId: "stub-provider",
        model: "stub-model",
      };
    }
    return {
      text: "done",
      toolCalls: [],
      usage: { input: 7, output: 2, cached: 0 },
      providerId: "stub-provider",
      model: "stub-model",
    };
  }
}

test("runScenario 注入真实形客户端：走通 read 场景并按注入单价核算成本", async () => {
  const metrics = await runScenario("read", {
    injected: {
      createClient: ({ scenario, cwd }) => {
        assert.equal(scenario, "read");
        return new TwoTurnClient(`${cwd}/fixture.txt`);
      },
      pricing: {
        main: { inputPerMillionCny: 5, outputPerMillionCny: 10, cachedInputPerMillionCny: 0 },
      },
    },
  });
  // 两回合 usage：in (123+7)=130, out (45+2)=47；成本按注入价而非占位价
  const expectedCost = (130 * 5 + 47 * 10) / 1_000_000;
  assert.equal(metrics.toolCalls, 1);
  assert.equal(metrics.toolErrors, 0);
  assert.equal(metrics.tokens.total, 177);
  assert.ok(Math.abs(metrics.cost - expectedCost) < 1e-12, `cost=${metrics.cost} expected≈${expectedCost}`);
  assert.equal(metrics.success, true);
});

test("buildInjectedEvalOptions 从生效配置构建注入缝", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "eval-real-home-"));
  await mkdir(path.join(home, ".myagent"), { recursive: true });
  await writeFile(
    path.join(home, ".myagent", "config.jsonc"),
    JSON.stringify({
      providers: [{
        id: "stubp",
        name: "Stub",
        enabled: true,
        protocol: "openai-compatible",
        baseUrl: "http://127.0.0.1:9",
        apiKey: "k",
        models: ["stub-model"],
      } as unknown as ModelProviderConfig],
      models: {
        main: { providerId: "stubp", model: "stub-model" } as RoleModelConfig,
        cheap: { providerId: "stubp", model: "stub-model" } as RoleModelConfig,
        explore: { providerId: "stubp", model: "stub-model" } as RoleModelConfig,
      },
    }),
    "utf8",
  );

  // cwd 也指向临时 HOME，避免读到仓库的项目级 .myagent/local.jsonc
  const options = await buildInjectedEvalOptions({ homeDir: home, cwd: home });
  assert.ok(options.injected, "应产出 injected 注入缝");
  assert.ok(options.injected.pricing.main, "pricing.main 应来自配置或内置价格表");
  assert.equal(options.injected.label.providerId, "stubp");
  assert.equal(options.injected.label.model, "stub-model");

  // 同一上下文两次 createClient 得到独立实例（离线断言，不打网络）
  const a = options.injected.createClient({ scenario: "read", cwd: process.cwd() });
  const b = options.injected.createClient({ scenario: "read", cwd: process.cwd() });
  assert.notEqual(a, b);

  // 真实入口的报告 projections 复用 createReport/reportMarkdown，此处只断言类型可流转
  assert.equal(typeof options.injected.pricing.main.inputPerMillionCny, "number");

  // 配置文件确实被读取
  const raw = await readFile(path.join(home, ".myagent", "config.jsonc"), "utf8");
  assert.match(raw, /stub-model/);
});
