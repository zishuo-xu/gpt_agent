import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * RichText（助手消息 markdown 轻量渲染）测试：
 * 标题 / 无序有序列表 / 引用 / 分隔线 / 行内 code / 粗体 / 链接（含危险协议拦截）。
 */

const mountedRoots: Array<{ unmount: () => void }> = [];

describe("RichText（markdown 渲染）", () => {
  before(() => {
    GlobalRegistrator.register();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  after(() => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount();
    }
  });

  async function render(text: string) {
    const [{ act }, { createRoot }, { RichText }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-render"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(<RichText text={text} />);
    });
    return container;
  }

  it("## 标题渲染为 h2（不再原样显示 # 前缀）", async () => {
    const container = await render("## 🛠 代码相关\n\n普通段落");
    const headings = container.querySelectorAll(".rich-text h2");
    assert.equal(headings.length, 1);
    assert.equal(headings[0]?.textContent, "🛠 代码相关");
    assert.ok(container.querySelector(".rich-text p"));
    assert.ok(
      !container.textContent?.includes("##"),
      "标题行不应残留 ## 前缀",
    );
  });

  it("无序/有序列表与引用、分隔线", async () => {
    const container = await render(
      [
        "- 第一项",
        "- 第二项",
        "1. 步骤一",
        "2. 步骤二",
        "> 引用文本",
        "---",
      ].join("\n"),
    );
    const text = container.textContent ?? "";
    assert.match(text, /• 第一项/);
    assert.match(text, /• 第二项/);
    assert.match(text, /1\. 步骤一/);
    assert.match(text, /2\. 步骤二/);
    assert.equal(container.querySelectorAll(".rich-text blockquote").length, 1);
    assert.equal(container.querySelectorAll(".rich-text hr").length, 1);
    assert.equal(container.querySelectorAll(".rich-text blockquote")[0]?.textContent, "引用文本");
  });

  it("行内 code / 粗体 / 链接（危险协议不放行）", async () => {
    const container = await render(
      "用 `pnpm test` 跑测试，**务必**通过。链接 [GitHub](https://github.com) 与 [危险](javascript:alert(1))",
    );
    assert.ok(container.querySelector(".rich-text code"));
    assert.equal(container.querySelector(".rich-text code")?.textContent, "pnpm test");
    assert.ok(container.querySelector(".rich-text strong"));
    assert.equal(container.querySelector(".rich-text strong")?.textContent, "务必");
    const links = container.querySelectorAll(".rich-text a");
    assert.equal(links.length, 1, "javascript: 链接不应渲染为可点击 a");
    assert.equal(links[0]?.getAttribute("href"), "https://github.com");
    assert.equal(links[0]?.textContent, "GitHub");
  });
});
