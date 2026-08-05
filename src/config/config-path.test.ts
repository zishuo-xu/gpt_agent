import assert from "node:assert/strict";
import test from "node:test";
import { getConfigValue, setConfigValue } from "./config-path.js";

/**
 * Schema 字段键读写（dotted key 支持）：
 * 设置页 generatedFields 对 server.host / behavior.showCacheMissNotices 等
 * 带点的键必须读写嵌套 section，否则保存会被后端静默丢弃。
 */

test("getConfigValue：dotted 键读嵌套 section，平铺键读顶层", () => {
  const config: Record<string, any> = {
    server: { host: "0.0.0.0", password: "" },
    notify: { webhook: "https://example.com/hook" },
    behavior: { showCacheMissNotices: true },
    providers: [],
  };
  assert.equal(getConfigValue(config, "server.host"), "0.0.0.0");
  assert.equal(getConfigValue(config, "notify.webhook"), "https://example.com/hook");
  assert.equal(getConfigValue(config, "behavior.showCacheMissNotices"), true);
  assert.deepEqual(getConfigValue(config, "providers"), []);
  assert.equal(getConfigValue(config, "server.missing"), undefined);
  assert.equal(getConfigValue(config, "nonexistent.key"), undefined);
});

test("setConfigValue：dotted 键写回嵌套 section（不可变，不丢其他字段）", () => {
  const config: Record<string, any> = {
    server: { host: "127.0.0.1", password: "old" },
    notify: { webhook: "" },
    providers: [],
  };
  const next: Record<string, any> = setConfigValue(config, "server.host", "0.0.0.0");
  assert.equal(next.server.host, "0.0.0.0");
  assert.equal(next.server.password, "old", "同 section 其他字段保留");
  assert.deepEqual(next.providers, [], "无关顶层字段保留");
  assert.equal(config.server.host, "127.0.0.1", "原对象不可变");
});

test("setConfigValue：section 缺失时创建，平铺键写顶层", () => {
  const next: Record<string, any> = setConfigValue(
    {} as Record<string, unknown>,
    "behavior.showCacheMissNotices",
    true,
  );
  assert.deepEqual(next.behavior, { showCacheMissNotices: true });
  const flat: Record<string, any> = setConfigValue(
    { a: 1 } as Record<string, unknown>,
    "flag",
    false,
  );
  assert.deepEqual(flat, { a: 1, flag: false });
});

test("任意深度 dotted 键读写（CLI /config set 复用）", () => {
  const config: Record<string, any> = {
    models: { main: { providerId: "deepseek", model: "chat" } },
  };
  assert.equal(
    getConfigValue(config, "models.main.model"),
    "chat",
  );
  const next: Record<string, any> = setConfigValue(
    config,
    "models.main.model",
    "chat-v2",
  );
  assert.equal(next.models.main.model, "chat-v2");
  assert.equal(config.models.main.model, "chat", "原对象不可变");
  assert.equal(
    getConfigValue(next, "models.main.nonexistent"),
    undefined,
  );
});
