import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Composer 斜杠命令面板（参照 Codex/Claude Code 的命令面板交互）与
 * SessionStatusBar 上下文水位段的组件级测试。
 *
 * 面板可见性派生自受控 message（/ 查询态），测试直接以 props 驱动渲染。
 */

const mountedRoots: Array<{ unmount: () => void }> = [];

before(() => {
  GlobalRegistrator.register();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

after(() => {
  for (const root of mountedRoots.splice(0)) {
    root.unmount();
  }
});

describe("Composer 斜杠命令（isSlashQuery / matchSlashCommands）", () => {
  it("isSlashQuery：/ 查询态判定（/、/co 合法；空格/空串/纯文本不合法）", async () => {
    const { isSlashQuery } = await import("./session-composer");
    assert.equal(isSlashQuery("/"), true);
    assert.equal(isSlashQuery("/cost"), true);
    assert.equal(isSlashQuery(" /co "), true, "首尾空白应容忍");
    assert.equal(isSlashQuery("/co x"), false, "出现空格即退出查询态");
    assert.equal(isSlashQuery(""), false);
    assert.equal(isSlashQuery("帮我修 bug"), false);
  });

  it("matchSlashCommands：按前缀过滤（去掉首字符 /）", async () => {
    const { matchSlashCommands } = await import("./session-composer");
    const commands = [
      { name: "/cost", desc: "", run: () => undefined },
      { name: "/context", desc: "", run: () => undefined },
      { name: "/help", desc: "", run: () => undefined },
    ];
    assert.deepEqual(
      matchSlashCommands("/", commands).map((c) => c.name),
      ["/cost", "/context", "/help"],
    );
    assert.deepEqual(
      matchSlashCommands("/co", commands).map((c) => c.name),
      ["/cost", "/context"],
    );
    assert.deepEqual(matchSlashCommands("/help", commands).map((c) => c.name), ["/help"]);
    assert.deepEqual(matchSlashCommands("/zzz", commands), []);
  });
});

describe("Composer 斜杠命令面板渲染", () => {
  async function renderComposer(options: {
    message: string;
    slashCommands?: Array<{ name: string; desc: string; run: () => void }>;
  }) {
    const [{ act }, { createRoot }, { Composer }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-composer"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const setMessages: string[] = [];
    const submits: Array<{ boundsConfirmed?: boolean; steer?: boolean }> = [];
    await act(async () => {
      root.render(
        <Composer
          message={options.message}
          setMessage={(value) => setMessages.push(value)}
          busy={false}
          submitting={false}
          selected
          runMode={false}
          onRunModeChange={() => undefined}
          planMode={false}
          onPlanModeChange={() => undefined}
          onSubmit={async (boundsConfirmed, steer) => {
            submits.push({ boundsConfirmed, steer });
          }}
          slashCommands={options.slashCommands}
        />,
      );
    });
    return {
      act,
      container,
      setMessages,
      submits,
      textarea: container.querySelector("textarea")!,
    };
  }

  const commands = [
    { name: "/cost", desc: "费用", run: () => undefined },
    { name: "/context", desc: "上下文", run: () => undefined },
    { name: "/help", desc: "帮助", run: () => undefined },
  ];

  it("message=/ 时面板列出全部命令", async () => {
    const scope = await renderComposer({ message: "/", slashCommands: commands });
    const menu = scope.container.querySelector(".slash-menu");
    assert.ok(menu, "查询态应出现命令面板");
    assert.equal(menu!.querySelectorAll(".slash-item").length, 3);
    assert.equal(
      menu!.querySelector(".slash-item code")?.textContent,
      "/cost",
      "默认选中第一项",
    );
  });

  it("message=/co 时前缀过滤只列 /cost 与 /context", async () => {
    const scope = await renderComposer({ message: "/co", slashCommands: commands });
    const items = [...scope.container.querySelectorAll(".slash-item code")].map(
      (el) => el.textContent,
    );
    assert.deepEqual(items, ["/cost", "/context"]);
  });

  it("查询无匹配时不渲染面板", async () => {
    const scope = await renderComposer({ message: "/zzz", slashCommands: commands });
    assert.equal(scope.container.querySelector(".slash-menu"), null);
  });

  it("非查询态（普通文本/空）不渲染面板", async () => {
    for (const message of ["帮我修一个 bug", ""]) {
      const scope = await renderComposer({ message, slashCommands: commands });
      assert.equal(
        scope.container.querySelector(".slash-menu"),
        null,
        `message=${JSON.stringify(message)} 不应出现面板`,
      );
    }
  });

  it("未注册命令时不渲染面板（首页形态）", async () => {
    const scope = await renderComposer({ message: "/" });
    assert.equal(scope.container.querySelector(".slash-menu"), null);
  });

  it("点击命令项：执行 run 并通过 setMessage 清空输入", async () => {
    let costRan = false;
    const scope = await renderComposer({
      message: "/co",
      slashCommands: [
        { name: "/cost", desc: "费用", run: () => { costRan = true; } },
        { name: "/context", desc: "上下文", run: () => undefined },
      ],
    });
    const item = scope.container.querySelector(".slash-item") as HTMLElement;
    await scope.act(async () => {
      item.click();
    });
    assert.equal(costRan, true, "点击应执行命令");
    assert.deepEqual(scope.setMessages, [""], "应清空输入框");
  });

  it("面板打开时按 Enter：执行选中命令且不触发消息发送", async () => {
    let costRan = false;
    const scope = await renderComposer({
      message: "/cost",
      slashCommands: [
        { name: "/cost", desc: "费用", run: () => { costRan = true; } },
      ],
    });
    await scope.act(async () => {
      scope.textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    assert.equal(costRan, true, "Enter 应执行选中命令");
    assert.deepEqual(scope.setMessages, [""], "执行后应清空输入框");
    assert.equal(scope.submits.length, 0, "不应触发消息发送");
  });
});

describe("SessionStatusBar 上下文水位段", () => {
  async function renderBar(options: {
    tokens?: number;
    contextTokens?: number;
    contextThreshold?: number;
  }) {
    const [{ act }, { createRoot }, { SessionStatusBar }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-statusbar"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <SessionStatusBar
          latestTodos={[]}
          fileChanges={[]}
          selected={{
            id: "s1",
            title: "会话",
            status: "done",
            permissionMode: "normal",
            createdAt: "2026-09-06T10:00:00.000Z",
            updatedAt: "2026-09-06T10:00:00.000Z",
            totalInputTokens: options.tokens ?? 0,
            totalOutputTokens: 0,
            totalCachedTokens: 0,
            totalCostCny: 0,
            todos: [],
            toolCallCount: 0,
            kind: "interactive",
          } as never}
          contextTokens={options.contextTokens}
          contextThreshold={options.contextThreshold}
          onOpen={() => undefined}
        />,
      );
    });
    return container;
  }

  it("有上下文数据时显示水位百分比，并显示累计 tokens", async () => {
    const container = await renderBar({
      tokens: 1_200,
      contextTokens: 45_000,
      contextThreshold: 90_000,
    });
    const text = container.textContent ?? "";
    assert.match(text, /上下文 50%/);
    assert.match(text, /1\.2k tokens/, "应显示累计 token 而非金额");
  });

  it("水位 ≥80% 时标记 context-high 警示色", async () => {
    const container = await renderBar({
      contextTokens: 85_000,
      contextThreshold: 90_000,
    });
    assert.ok(
      container.querySelector(".context-high"),
      "≥80% 应带 context-high 类",
    );
    assert.match(container.textContent ?? "", /上下文 94%/);
  });

  it("无上下文数据时不渲染水位段", async () => {
    const container = await renderBar({ tokens: 500 });
    assert.match(container.textContent ?? "", /500 tokens/);
    assert.doesNotMatch(container.textContent ?? "", /上下文/);
  });
});
