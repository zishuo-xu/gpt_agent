import { useEffect, useMemo, useState } from "react";

type Scope = "global" | "project";
type Protocol = "anthropic" | "openai-compatible";
type Role = "main" | "cheap" | "explore";

interface Provider {
  id: string;
  name: string;
  enabled: boolean;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  models: string[];
}

interface ModelSelection {
  providerId: string;
  model: string;
  pricing?: {
    inputPerMillionCny: number;
    outputPerMillionCny: number;
    cachedInputPerMillionCny: number;
  };
  fallbacks?: ModelSelection[];
}

interface Config {
  providers: Provider[];
  models: Record<Role, ModelSelection>;
  permissions: {
    mode: "strict" | "normal" | "trust";
    rules: Array<{
      effect: "allow" | "ask" | "deny";
      pattern: string;
    }>;
    approvalTimeoutMs: number;
  };
  context: {
    compactAtEstimatedTokens: number;
    keepRecentTurns: number;
  };
  [key: string]: unknown;
}

interface SchemaField {
  key: string;
  type:
    | "provider[]"
    | "role-models"
    | "permissions"
    | "context"
    | "string"
    | "number"
    | "boolean"
    | "select";
  title: string;
  description: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: string }>;
  hot?: boolean;
}

interface TestResult {
  ok: boolean;
  reachable: boolean;
  providerId: string;
  model: string;
  latencyMs: number;
  message: string;
}

const roleMeta: Record<Role, { label: string; hint: string }> = {
  main: { label: "主循环模型", hint: "复杂推理、编辑与任务执行" },
  cheap: { label: "压缩摘要", hint: "上下文压缩、会话标题" },
  explore: { label: "子代理探索", hint: "代码搜索与只读归纳" },
};

export function App() {
  const [scope, setScope] = useState<Scope>("global");
  const [config, setConfig] = useState<Config | null>(null);
  const [schema, setSchema] = useState<SchemaField[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revealedKey, setRevealedKey] = useState(false);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [notice, setNotice] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    document.title = "模型设置 · MyAgent";
    void fetch("/api/config/schema")
      .then((response) => response.json())
      .then((payload) => setSchema(payload.fields ?? []));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setNotice(null);
    setTestResults({});
    void fetch(`/api/config?scope=${scope}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("读取配置失败");
        return response.json();
      })
      .then((payload) => {
        const next = payload.config as Config;
        setConfig(next);
        setSelectedProviderId(next.providers[0]?.id ?? "");
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setNotice({ tone: "error", text: error.message });
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [scope]);

  const selectedProvider = useMemo(
    () =>
      config?.providers.find((provider) => provider.id === selectedProviderId) ??
      config?.providers[0] ??
      null,
    [config, selectedProviderId],
  );

  const providerDescription = useMemo(
    () => schema.find((field) => field.key === "providers")?.description,
    [schema],
  );

  const generatedFields = useMemo(
    () =>
      schema.filter((field) =>
        ["string", "number", "boolean", "select"].includes(field.type),
      ),
    [schema],
  );

  function replaceConfig(recipe: (current: Config) => Config) {
    setNotice(null);
    setConfig((current) => (current ? recipe(current) : current));
  }

  function updateProvider(index: number, patch: Partial<Provider>) {
    replaceConfig((current) => {
      const previous = current.providers[index];
      if (!previous) return current;
      const providers = current.providers.map((provider, providerIndex) =>
        providerIndex === index ? { ...provider, ...patch } : provider,
      );
      if (!patch.id || patch.id === previous.id) {
        return { ...current, providers };
      }
      const models = { ...current.models };
      for (const role of Object.keys(models) as Role[]) {
        if (models[role].providerId === previous.id) {
          models[role] = { ...models[role], providerId: patch.id };
        }
        models[role] = {
          ...models[role],
          fallbacks: models[role].fallbacks?.map((fallback) =>
            fallback.providerId === previous.id
              ? { ...fallback, providerId: patch.id! }
              : fallback,
          ),
        };
      }
      setSelectedProviderId(patch.id);
      return { ...current, providers, models };
    });
  }

  function toggleProvider(index: number) {
    replaceConfig((current) => {
      const provider = current.providers[index];
      if (!provider) return current;
      const enabled = !provider.enabled;
      const providers = current.providers.map((item, itemIndex) =>
        itemIndex === index ? { ...item, enabled } : item,
      );
      const fallback = providers.find(
        (item) => item.enabled && item.id !== provider.id,
      );
      const models = { ...current.models };
      if (!enabled && fallback) {
        for (const role of Object.keys(models) as Role[]) {
          if (models[role].providerId === provider.id) {
            models[role] = {
              ...models[role],
              providerId: fallback.id,
              model: fallback.models[0] ?? "",
            };
          }
          models[role] = {
            ...models[role],
            fallbacks: models[role].fallbacks?.filter(
              (selection) =>
                selection.providerId !== provider.id,
            ),
          };
        }
      }
      return { ...current, providers, models };
    });
  }

  function addProvider() {
    replaceConfig((current) => {
      let suffix = current.providers.length + 1;
      while (current.providers.some((item) => item.id === `custom-${suffix}`)) {
        suffix += 1;
      }
      const provider: Provider = {
        id: `custom-${suffix}`,
        name: "新供应商",
        enabled: true,
        protocol: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "",
        hasApiKey: false,
        models: ["model-name"],
      };
      setSelectedProviderId(provider.id);
      return { ...current, providers: [...current.providers, provider] };
    });
  }

  function removeProvider(index: number) {
    replaceConfig((current) => {
      if (current.providers.length === 1) return current;
      const removed = current.providers[index];
      const providers = current.providers.filter((_, itemIndex) => itemIndex !== index);
      const fallback = providers.find((item) => item.enabled) ?? providers[0]!;
      const models = { ...current.models };
      for (const role of Object.keys(models) as Role[]) {
        if (models[role].providerId === removed?.id) {
          models[role] = {
            ...models[role],
            providerId: fallback.id,
            model: fallback.models[0] ?? "",
          };
        }
        models[role] = {
          ...models[role],
          fallbacks: models[role].fallbacks?.filter(
            (selection) =>
              selection.providerId !== removed?.id,
          ),
        };
      }
      setSelectedProviderId(fallback.id);
      return { ...current, providers, models };
    });
  }

  function updateModel(providerIndex: number, modelIndex: number, value: string) {
    replaceConfig((current) => {
      const provider = current.providers[providerIndex];
      if (!provider) return current;
      const previousModel = provider.models[modelIndex];
      const nextModels = provider.models.map((model, index) =>
        index === modelIndex ? value : model,
      );
      const providers = current.providers.map((item, index) =>
        index === providerIndex ? { ...item, models: nextModels } : item,
      );
      const models = { ...current.models };
      for (const role of Object.keys(models) as Role[]) {
        if (
          models[role].providerId === provider.id &&
          models[role].model === previousModel
        ) {
          models[role] = { ...models[role], model: value };
        }
        models[role] = {
          ...models[role],
          fallbacks: models[role].fallbacks?.map((fallback) =>
            fallback.providerId === provider.id &&
            fallback.model === previousModel
              ? { ...fallback, model: value }
              : fallback,
          ),
        };
      }
      return { ...current, providers, models };
    });
  }

  function addModel(providerIndex: number) {
    replaceConfig((current) => {
      const provider = current.providers[providerIndex];
      if (!provider) return current;
      let suffix = provider.models.length + 1;
      let modelName = `new-model-${suffix}`;
      while (provider.models.includes(modelName)) {
        suffix += 1;
        modelName = `new-model-${suffix}`;
      }
      const providers = current.providers.map((item, index) =>
        index === providerIndex
          ? { ...item, models: [...item.models, modelName] }
          : item,
      );
      return { ...current, providers };
    });
  }

  function removeModel(providerIndex: number, modelIndex: number) {
    replaceConfig((current) => {
      const provider = current.providers[providerIndex];
      if (!provider || provider.models.length === 1) return current;
      const removedModel = provider.models[modelIndex];
      const nextModels = provider.models.filter((_, index) => index !== modelIndex);
      const providers = current.providers.map((item, index) =>
        index === providerIndex ? { ...item, models: nextModels } : item,
      );
      const models = { ...current.models };
      for (const role of Object.keys(models) as Role[]) {
        if (
          models[role].providerId === provider.id &&
          models[role].model === removedModel
        ) {
          models[role] = { ...models[role], model: nextModels[0] ?? "" };
        }
        models[role] = {
          ...models[role],
          fallbacks: models[role].fallbacks
            ?.map((fallback) =>
              fallback.providerId === provider.id &&
              fallback.model === removedModel
                ? {
                    ...fallback,
                    model: nextModels[0] ?? "",
                  }
                : fallback,
            )
            .filter((fallback) => fallback.model),
        };
      }
      return { ...current, providers, models };
    });
  }

  function updateRole(role: Role, patch: Partial<ModelSelection>) {
    replaceConfig((current) => ({
      ...current,
      models: {
        ...current.models,
        [role]: { ...current.models[role], ...patch },
      },
    }));
  }

  function selectRoleProvider(role: Role, providerId: string) {
    const provider = config?.providers.find((item) => item.id === providerId);
    updateRole(role, {
      providerId,
      model: provider?.models[0] ?? "",
    });
  }

  function updateRolePricing(
    role: Role,
    key:
      | "inputPerMillionCny"
      | "outputPerMillionCny"
      | "cachedInputPerMillionCny",
    value: string,
  ) {
    const current = config?.models[role].pricing ?? {
      inputPerMillionCny: 0,
      outputPerMillionCny: 0,
      cachedInputPerMillionCny: 0,
    };
    updateRole(role, {
      pricing: {
        ...current,
        [key]: Number(value) || 0,
      },
    });
  }

  function addRoleFallback(role: Role) {
    const provider = config?.providers.find((item) => item.enabled);
    if (!provider) return;
    const selection = config?.models[role];
    updateRole(role, {
      fallbacks: [
        ...(selection?.fallbacks ?? []),
        {
          providerId: provider.id,
          model: provider.models[0] ?? "",
        },
      ],
    });
  }

  function updateRoleFallback(
    role: Role,
    index: number,
    patch: Partial<ModelSelection>,
  ) {
    const selection = config?.models[role];
    if (!selection) return;
    updateRole(role, {
      fallbacks: (selection.fallbacks ?? []).map(
        (fallback, fallbackIndex) =>
          fallbackIndex === index
            ? { ...fallback, ...patch }
            : fallback,
      ),
    });
  }

  function removeRoleFallback(role: Role, index: number) {
    const selection = config?.models[role];
    if (!selection) return;
    updateRole(role, {
      fallbacks: (selection.fallbacks ?? []).filter(
        (_, fallbackIndex) => fallbackIndex !== index,
      ),
    });
  }

  function updatePermission(
    patch: Partial<Config["permissions"]>,
  ) {
    replaceConfig((current) => ({
      ...current,
      permissions: { ...current.permissions, ...patch },
    }));
  }

  function updateRule(
    index: number,
    patch: Partial<Config["permissions"]["rules"][number]>,
  ) {
    replaceConfig((current) => ({
      ...current,
      permissions: {
        ...current.permissions,
        rules: current.permissions.rules.map((rule, ruleIndex) =>
          ruleIndex === index ? { ...rule, ...patch } : rule,
        ),
      },
    }));
  }

  async function save(options: { quiet?: boolean } = {}): Promise<boolean> {
    if (!config) return false;
    setSaving(true);
    if (!options.quiet) setNotice(null);
    try {
      const response = await fetch(`/api/config?scope=${scope}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error((payload.issues ?? [payload.error]).join("；"));
      }
      setConfig(payload.config);
      if (!options.quiet) {
        setNotice({ tone: "ok", text: "配置已保存。" });
      }
      return true;
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "保存失败",
      });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function testConnection(provider: Provider, model: string) {
    if (!model.trim()) {
      setNotice({ tone: "error", text: "请先填写模型名称。" });
      return;
    }
    const saved = await save({ quiet: true });
    if (!saved) return;
    const resultKey = `${provider.id}:${model}`;
    setTestingKey(resultKey);
    setNotice(null);
    try {
      const response = await fetch(`/api/config/test?scope=${scope}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: provider.id, model }),
      });
      const result = (await response.json()) as TestResult;
      setTestResults((current) => ({ ...current, [resultKey]: result }));
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [resultKey]: {
          ok: false,
          reachable: false,
          providerId: provider.id,
          model,
          latencyMs: 0,
          message: error instanceof Error ? error.message : "测试失败",
        },
      }));
    } finally {
      setTestingKey(null);
    }
  }

  const selectedIndex =
    config?.providers.findIndex((provider) => provider.id === selectedProvider?.id) ??
    -1;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <span>MyAgent</span>
        </div>
        <nav aria-label="主导航">
          <button
            className="nav-item"
            onClick={() => {
              window.location.hash = "sessions";
            }}
          >
            <span>▦</span>监控台
          </button>
          <button
            className="nav-item"
            onClick={() => {
              window.location.hash = "sessions";
            }}
          >
            <span>◉</span>会话详情
          </button>
          <button
            className="nav-item"
            onClick={() => {
              window.location.hash = "memory";
            }}
          >
            <span>✎</span>记忆面板
          </button>
          <button className="nav-item active">
            <span>⚙</span>设置
          </button>
        </nav>
        <div className="local-state">
          <span className="status-dot" />
          本机服务
          <small>{window.location.host}</small>
        </div>
      </aside>

      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">SETTINGS / MODELS</p>
            <h1>模型设置</h1>
            <p>管理模型供应商，并为每个模型独立验证连接状态。</p>
          </div>
          <button
            className="save-button"
            onClick={() => void save()}
            disabled={saving || loading}
          >
            {saving ? "保存中…" : "保存更改"}
          </button>
        </header>

        <div className="scope-switch" aria-label="配置作用域">
          <button
            className={scope === "global" ? "selected" : ""}
            onClick={() => setScope("global")}
          >
            全局
          </button>
          <button
            className={scope === "project" ? "selected" : ""}
            onClick={() => setScope("project")}
          >
            当前项目
          </button>
        </div>

        {notice && <div className={`notice ${notice.tone}`}>{notice.text}</div>}

        {loading || !config ? (
          <div className="loading-card">正在读取本机配置…</div>
        ) : (
          <div className="content">
            <section className="panel provider-panel">
              <div className="section-heading compact-heading">
                <div>
                  <h2>模型供应商</h2>
                  <p>
                    {providerDescription ??
                      "支持 Anthropic 与任意 OpenAI-compatible 第三方端点。"}
                  </p>
                </div>
              </div>

              <div className="provider-workspace">
                <aside className="provider-nav">
                  <p className="provider-group-label">供应商 · 可同时启用多个</p>
                  <div className="provider-nav-list">
                    {config.providers.map((provider) => (
                      <button
                        className={`provider-nav-item ${
                          provider.id === selectedProvider?.id ? "selected" : ""
                        }`}
                        key={provider.id}
                        onClick={() => {
                          setSelectedProviderId(provider.id);
                          setRevealedKey(false);
                        }}
                      >
                        <span className="provider-cube">◇</span>
                        <span>
                          <strong>{provider.name || "未命名供应商"}</strong>
                          <small>{provider.protocol === "anthropic" ? "Messages" : "Chat Completions"}</small>
                        </span>
                        <i className={provider.enabled ? "enabled" : ""} />
                      </button>
                    ))}
                  </div>
                  <button className="add-provider-button" onClick={addProvider}>
                    <span>＋</span>添加供应商
                  </button>
                </aside>

                {selectedProvider && selectedIndex >= 0 && (
                  <section className="provider-editor">
                    <div className="provider-editor-header">
                      <div>
                        <div className="provider-name-line">
                          <input
                            className="provider-name-input"
                            value={selectedProvider.name}
                            onChange={(event) =>
                              updateProvider(selectedIndex, {
                                name: event.target.value,
                              })
                            }
                            aria-label="供应商名称"
                          />
                          <span className="editable-hint">✎ 可编辑名称</span>
                        </div>
                        <span className="provider-id-label">{selectedProvider.id}</span>
                      </div>
                      <div className="provider-editor-actions">
                        <button
                          className={`enable-button ${
                            selectedProvider.enabled ? "on" : ""
                          }`}
                          onClick={() => toggleProvider(selectedIndex)}
                        >
                          {selectedProvider.enabled
                            ? "供应商已启用"
                            : "供应商已禁用"}
                        </button>
                        <button
                          className="delete-provider-button"
                          onClick={() => removeProvider(selectedIndex)}
                          disabled={config.providers.length === 1}
                        >
                          删除供应商
                        </button>
                      </div>
                    </div>

                    <div className="provider-fields">
                      <label>
                        Base URL
                        <input
                          value={selectedProvider.baseUrl}
                          onChange={(event) =>
                            updateProvider(selectedIndex, {
                              baseUrl: event.target.value,
                            })
                          }
                          placeholder="https://api.example.com/v1"
                        />
                      </label>
                      <label>
                        API 格式
                        <select
                          value={selectedProvider.protocol}
                          onChange={(event) =>
                            updateProvider(selectedIndex, {
                              protocol: event.target.value as Protocol,
                            })
                          }
                        >
                          <option value="openai-compatible">
                            Chat Completions (/chat/completions)
                          </option>
                          <option value="anthropic">
                            Anthropic Messages (/messages)
                          </option>
                        </select>
                      </label>
                      <label>
                        API Key
                        <div className="secret-field">
                          <input
                            type={revealedKey ? "text" : "password"}
                            value={selectedProvider.apiKey}
                            onChange={(event) =>
                              updateProvider(selectedIndex, {
                                apiKey: event.target.value,
                              })
                            }
                            placeholder={
                              selectedProvider.hasApiKey
                                ? "已保存；留空保持原值"
                                : "输入 API Key"
                            }
                            autoComplete="off"
                          />
                          <button
                            onClick={() => setRevealedKey((value) => !value)}
                            aria-label={revealedKey ? "隐藏 API Key" : "显示 API Key"}
                          >
                            {revealedKey ? "隐藏" : "显示"}
                          </button>
                        </div>
                      </label>
                      <label>
                        供应商 ID
                        <input
                          value={selectedProvider.id}
                          onChange={(event) =>
                            updateProvider(selectedIndex, { id: event.target.value })
                          }
                        />
                      </label>
                    </div>

                    <div className="model-list-section">
                      <div className="model-list-heading">
                        <div>
                          <h3>模型列表</h3>
                          <p>
                            列表内模型均可用，可同时被不同角色选择；每个模型独立测试。
                          </p>
                        </div>
                        <span>{selectedProvider.models.length} 个模型</span>
                      </div>

                      <div className="model-rows">
                        {selectedProvider.models.map((model, modelIndex) => {
                          const resultKey = `${selectedProvider.id}:${model}`;
                          const result = testResults[resultKey];
                          return (
                            <div className="model-row-wrap" key={modelIndex}>
                              <div className="model-row">
                                <span className="model-icon">◇</span>
                                <input
                                  value={model}
                                  onChange={(event) =>
                                    updateModel(
                                      selectedIndex,
                                      modelIndex,
                                      event.target.value,
                                    )
                                  }
                                  aria-label={`模型 ${modelIndex + 1}`}
                                />
                                <button
                                  className="model-test-button"
                                  onClick={() =>
                                    void testConnection(selectedProvider, model)
                                  }
                                  disabled={
                                    saving ||
                                    testingKey !== null ||
                                    !model.trim()
                                  }
                                >
                                  {testingKey === resultKey ? "测试中…" : "测试连接"}
                                </button>
                                <button
                                  className="model-delete-button"
                                  onClick={() =>
                                    removeModel(selectedIndex, modelIndex)
                                  }
                                  disabled={selectedProvider.models.length === 1}
                                >
                                  删除
                                </button>
                              </div>
                              {result && (
                                <div
                                  className={`model-test-result ${
                                    result.ok
                                      ? "success"
                                      : result.reachable
                                        ? "warning"
                                        : "failure"
                                  }`}
                                >
                                  <span className="test-result-dot" />
                                  <strong>
                                    {result.ok
                                      ? "连接正常"
                                      : result.reachable
                                        ? "服务可达"
                                        : "连接失败"}
                                  </strong>
                                  <span>{result.message}</span>
                                  <code>{result.latencyMs}ms</code>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <button
                        className="add-model-button"
                        onClick={() => addModel(selectedIndex)}
                      >
                        ＋ 添加模型
                      </button>
                    </div>
                  </section>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>角色模型</h2>
                  <p>
                    每个角色选择一个模型，三个角色可以使用同一模型或不同模型。
                  </p>
                </div>
              </div>
              <div className="role-grid">
                {(Object.keys(roleMeta) as Role[]).map((role) => {
                  const selection = config.models[role];
                  const provider = config.providers.find(
                    (item) => item.id === selection.providerId,
                  );
                  return (
                    <div className="role-card" key={role}>
                      <span className="role-code">{role}</span>
                      <h3>{roleMeta[role].label}</h3>
                      <p>{roleMeta[role].hint}</p>
                      <label>
                        供应商
                        <select
                          value={selection.providerId}
                          onChange={(event) =>
                            selectRoleProvider(role, event.target.value)
                          }
                        >
                          {config.providers
                            .filter((item) => item.enabled)
                            .map((item) => (
                              <option value={item.id} key={item.id}>
                                {item.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        模型
                        <select
                          value={selection.model}
                          onChange={(event) =>
                            updateRole(role, { model: event.target.value })
                          }
                        >
                          {(provider?.models ?? []).map((model) => (
                            <option value={model} key={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                      </label>
                      <details className="role-advanced">
                        <summary>费用与 fallback</summary>
                        <div className="pricing-grid">
                          <label>
                            输入 ¥/百万 tokens
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={
                                selection.pricing
                                  ?.inputPerMillionCny ?? 0
                              }
                              onChange={(event) =>
                                updateRolePricing(
                                  role,
                                  "inputPerMillionCny",
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                          <label>
                            输出 ¥/百万 tokens
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={
                                selection.pricing
                                  ?.outputPerMillionCny ?? 0
                              }
                              onChange={(event) =>
                                updateRolePricing(
                                  role,
                                  "outputPerMillionCny",
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                          <label>
                            缓存 ¥/百万 tokens
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={
                                selection.pricing
                                  ?.cachedInputPerMillionCny ?? 0
                              }
                              onChange={(event) =>
                                updateRolePricing(
                                  role,
                                  "cachedInputPerMillionCny",
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                        </div>
                        <div className="fallback-list">
                          {(selection.fallbacks ?? []).map(
                            (fallback, fallbackIndex) => {
                              const fallbackProvider =
                                config.providers.find(
                                  (item) =>
                                    item.id ===
                                    fallback.providerId,
                                );
                              return (
                                <div
                                  className="fallback-row"
                                  key={fallbackIndex}
                                >
                                  <span>
                                    {fallbackIndex + 1}
                                  </span>
                                  <select
                                    value={fallback.providerId}
                                    onChange={(event) => {
                                      const nextProvider =
                                        config.providers.find(
                                          (item) =>
                                            item.id ===
                                            event.target.value,
                                        );
                                      updateRoleFallback(
                                        role,
                                        fallbackIndex,
                                        {
                                          providerId:
                                            event.target.value,
                                          model:
                                            nextProvider
                                              ?.models[0] ?? "",
                                        },
                                      );
                                    }}
                                  >
                                    {config.providers
                                      .filter(
                                        (item) => item.enabled,
                                      )
                                      .map((item) => (
                                        <option
                                          value={item.id}
                                          key={item.id}
                                        >
                                          {item.name}
                                        </option>
                                      ))}
                                  </select>
                                  <select
                                    value={fallback.model}
                                    onChange={(event) =>
                                      updateRoleFallback(
                                        role,
                                        fallbackIndex,
                                        {
                                          model:
                                            event.target.value,
                                        },
                                      )
                                    }
                                  >
                                    {(
                                      fallbackProvider?.models ?? []
                                    ).map((model) => (
                                      <option
                                        value={model}
                                        key={model}
                                      >
                                        {model}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    onClick={() =>
                                      removeRoleFallback(
                                        role,
                                        fallbackIndex,
                                      )
                                    }
                                  >
                                    删除
                                  </button>
                                </div>
                              );
                            },
                          )}
                          <button
                            className="add-fallback-button"
                            onClick={() => addRoleFallback(role)}
                          >
                            ＋ 添加备用模型
                          </button>
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>权限与审批</h2>
                  <p>
                    {schema.find(
                      (field) => field.key === "permissions",
                    )?.description ??
                      "会话默认档位、规则与审批超时。"}
                  </p>
                </div>
              </div>
              <div className="behavior-grid">
                <label>
                  默认权限档
                  <select
                    value={config.permissions.mode}
                    onChange={(event) =>
                      updatePermission({
                        mode: event.target
                          .value as Config["permissions"]["mode"],
                      })
                    }
                  >
                    <option value="strict">strict</option>
                    <option value="normal">normal</option>
                    <option value="trust">trust</option>
                  </select>
                </label>
                <label>
                  审批超时（秒）
                  <input
                    type="number"
                    min="1"
                    value={Math.round(
                      config.permissions.approvalTimeoutMs /
                        1000,
                    )}
                    onChange={(event) =>
                      updatePermission({
                        approvalTimeoutMs:
                          Number(event.target.value) * 1000,
                      })
                    }
                  />
                </label>
              </div>
              <div className="permission-rule-list">
                {config.permissions.rules.map((rule, index) => (
                  <div className="permission-rule-row" key={index}>
                    <select
                      value={rule.effect}
                      onChange={(event) =>
                        updateRule(index, {
                          effect: event.target
                            .value as typeof rule.effect,
                        })
                      }
                    >
                      <option value="allow">allow</option>
                      <option value="ask">ask</option>
                      <option value="deny">deny</option>
                    </select>
                    <input
                      value={rule.pattern}
                      onChange={(event) =>
                        updateRule(index, {
                          pattern: event.target.value,
                        })
                      }
                      placeholder="Bash(git commit *)"
                    />
                    <button
                      onClick={() =>
                        updatePermission({
                          rules:
                            config.permissions.rules.filter(
                              (_, ruleIndex) =>
                                ruleIndex !== index,
                            ),
                        })
                      }
                    >
                      删除
                    </button>
                  </div>
                ))}
                <button
                  className="add-model-button"
                  onClick={() =>
                    updatePermission({
                      rules: [
                        ...config.permissions.rules,
                        {
                          effect: "ask",
                          pattern: "Bash(command *)",
                        },
                      ],
                    })
                  }
                >
                  ＋ 添加规则
                </button>
              </div>
            </section>

            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>上下文</h2>
                  <p>
                    {schema.find(
                      (field) => field.key === "context",
                    )?.description ??
                      "硬压缩阈值与保留轮数。"}
                  </p>
                </div>
              </div>
              <div className="behavior-grid">
                <label>
                  硬压缩触发（估算 tokens）
                  <input
                    type="number"
                    min="1000"
                    value={
                      config.context
                        .compactAtEstimatedTokens
                    }
                    onChange={(event) =>
                      replaceConfig((current) => ({
                        ...current,
                        context: {
                          ...current.context,
                          compactAtEstimatedTokens: Number(
                            event.target.value,
                          ),
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  压缩后保留最近轮数
                  <input
                    type="number"
                    min="1"
                    value={config.context.keepRecentTurns}
                    onChange={(event) =>
                      replaceConfig((current) => ({
                        ...current,
                        context: {
                          ...current.context,
                          keepRecentTurns: Number(
                            event.target.value,
                          ),
                        },
                      }))
                    }
                  />
                </label>
              </div>
            </section>

            {generatedFields.length > 0 && (
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>扩展设置</h2>
                    <p>
                      以下字段由 Config Schema 自动生成，无需修改前端代码。
                    </p>
                  </div>
                </div>
                <div className="schema-field-grid">
                  {generatedFields.map((field) => {
                    const value =
                      config[field.key] ?? field.default ?? "";
                    return (
                      <label className="schema-field" key={field.key}>
                        <span>
                          {field.title}
                          {field.hot && <em>即时生效</em>}
                        </span>
                        <small>{field.description}</small>
                        {field.type === "boolean" ? (
                          <input
                            type="checkbox"
                            checked={value === true}
                            onChange={(event) =>
                              replaceConfig((current) => ({
                                ...current,
                                [field.key]: event.target.checked,
                              }))
                            }
                          />
                        ) : field.type === "select" ? (
                          <select
                            value={String(value)}
                            onChange={(event) =>
                              replaceConfig((current) => ({
                                ...current,
                                [field.key]: event.target.value,
                              }))
                            }
                          >
                            {(field.options ?? []).map((option) => (
                              <option value={option.value} key={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={field.type === "number" ? "number" : "text"}
                            value={String(value)}
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            onChange={(event) =>
                              replaceConfig((current) => ({
                                ...current,
                                [field.key]:
                                  field.type === "number"
                                    ? Number(event.target.value)
                                    : event.target.value,
                              }))
                            }
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
