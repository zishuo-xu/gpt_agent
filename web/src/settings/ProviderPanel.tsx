import type { ConnectionTestResult as TestResult } from "@shared/types.js";
import type { Provider, Scope } from "./types";

export interface ProviderPanelProps {
  providers: Provider[];
  selectedProviderId: string;
  selectedIndex: number;
  scope: Scope;
  projectKeyOverrides: {
    cwd: string;
    configPath: string;
    providers: Array<{ id: string; name: string }>;
  } | null;
  revealedKey: boolean;
  saving: boolean;
  testingKey: string | null;
  testResults: Record<string, TestResult>;
  onSelectProvider: (id: string) => void;
  onResetRevealedKey: () => void;
  onToggleRevealedKey: () => void;
  onAddProvider: () => void;
  onRemoveProvider: (index: number) => void;
  onToggleProvider: (index: number) => void;
  onUpdateProvider: (index: number, patch: Partial<Provider>) => void;
  onUpdateModel: (
    providerIndex: number,
    modelIndex: number,
    value: string,
  ) => void;
  onAddModel: (providerIndex: number) => void;
  onRemoveModel: (providerIndex: number, modelIndex: number) => void;
  onTestConnection: (provider: Provider, model: string) => void;
  providerDescription?: string;
}

export function ProviderPanel(props: ProviderPanelProps) {
  const {
    providers,
    selectedProviderId,
    selectedIndex,
    scope,
    projectKeyOverrides,
    revealedKey,
    saving,
    testingKey,
    testResults,
  } = props;
  const selectedProvider = providers.find(
    (provider) => provider.id === selectedProviderId,
  );

  return (
    <section className="panel provider-panel">
      <div className="section-heading compact-heading">
        <div>
          <h2>模型供应商</h2>
          <p>
            {props.providerDescription ??
              "支持 Anthropic 与任意 OpenAI-compatible 第三方端点。"}
          </p>
        </div>
      </div>

      <div className="provider-workspace">
        <aside className="provider-nav">
          <p className="provider-group-label">供应商 · 可同时启用多个</p>
          <div className="provider-nav-list">
            {providers.map((provider) => (
              <button
                className={`provider-nav-item ${
                  provider.id === selectedProvider?.id ? "selected" : ""
                }`}
                key={provider.id}
                onClick={() => {
                  props.onSelectProvider(provider.id);
                  props.onResetRevealedKey();
                }}
              >
                <span className="provider-cube">◇</span>
                <span>
                  <strong>{provider.name || "未命名供应商"}</strong>
                  <small>
                    {provider.protocol === "anthropic"
                      ? "Messages"
                      : "Chat Completions"}
                  </small>
                </span>
                <i className={provider.enabled ? "enabled" : ""} />
              </button>
            ))}
          </div>
          <button className="add-provider-button" onClick={props.onAddProvider}>
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
                      props.onUpdateProvider(selectedIndex, {
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
                  onClick={() => props.onToggleProvider(selectedIndex)}
                >
                  {selectedProvider.enabled ? "供应商已启用" : "供应商已禁用"}
                </button>
                <button
                  className="delete-provider-button"
                  onClick={() => {
                    if (
                      window.confirm(
                        `确认删除供应商「${
                          selectedProvider.name || selectedProvider.id
                        }」？相关角色会切换到其他供应商。`,
                      )
                    ) {
                      props.onRemoveProvider(selectedIndex);
                    }
                  }}
                  disabled={providers.length === 1}
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
                    props.onUpdateProvider(selectedIndex, {
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
                    props.onUpdateProvider(selectedIndex, {
                      protocol: event.target.value as Provider["protocol"],
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
                推理内容（thinking）
                <div className="toggle-field">
                  <button
                    className={`toggle-button ${
                      selectedProvider.thinking ? "on" : ""
                    }`}
                    onClick={() =>
                      props.onUpdateProvider(selectedIndex, {
                        thinking: !selectedProvider.thinking,
                      })
                    }
                    type="button"
                  >
                    {selectedProvider.thinking ? "已开启" : "已关闭"}
                  </button>
                  <span className="field-hint">
                    开启后请求携带 thinking 参数并解析推理内容；增加 output token 成本
                  </span>
                </div>
              </label>
              {selectedProvider.thinking && (
                <label>
                  推理预算（tokens）
                  <input
                    type="number"
                    min={1024}
                    value={
                      selectedProvider.thinkingBudgetTokens ?? 2048
                    }
                    onChange={(event) =>
                      props.onUpdateProvider(selectedIndex, {
                        thinkingBudgetTokens: Number(event.target.value) || 2048,
                      })
                    }
                  />
                </label>
              )}
              <label>
                API Key
                <div className="secret-field">
                  <input
                    type={revealedKey ? "text" : "password"}
                    value={selectedProvider.apiKey}
                    onChange={(event) =>
                      props.onUpdateProvider(selectedIndex, {
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
                    onClick={props.onToggleRevealedKey}
                    aria-label={revealedKey ? "隐藏 API Key" : "显示 API Key"}
                  >
                    {revealedKey ? "隐藏" : "显示"}
                  </button>
                </div>
                {scope === "global" &&
                  projectKeyOverrides?.providers.some(
                    (override) => override.id === selectedProvider.id,
                  ) && (
                    <p className="key-override-hint">
                      ⚠ 当前项目（{projectKeyOverrides.cwd}）的 local.jsonc 中该渠道已配置非空 API Key，会覆盖此全局 Key；
                      如需全局 Key 生效，请清空项目 Key。
                    </p>
                  )}
              </label>
              <label>
                供应商 ID
                <input
                  value={selectedProvider.id}
                  onChange={(event) =>
                    props.onUpdateProvider(selectedIndex, {
                      id: event.target.value,
                    })
                  }
                />
              </label>
            </div>

            <div className="model-list-section">
              <div className="model-list-heading">
                <div>
                  <h3>模型列表</h3>
                  <p>列表内模型均可用，可同时被不同角色选择；每个模型独立测试。</p>
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
                            props.onUpdateModel(
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
                            props.onTestConnection(selectedProvider, model)
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
                            props.onRemoveModel(selectedIndex, modelIndex)
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
                onClick={() => props.onAddModel(selectedIndex)}
              >
                ＋ 添加模型
              </button>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
