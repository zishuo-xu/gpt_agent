import type { Config, ModelSelection, Role } from "./types";
import { roleMeta } from "./types";

export interface RoleModelsPanelProps {
  providers: Config["providers"];
  models: Config["models"];
  onSelectRoleProvider: (role: Role, providerId: string) => void;
  onUpdateRole: (role: Role, patch: Partial<ModelSelection>) => void;
  onUpdateRolePricing: (
    role: Role,
    key:
      | "inputPerMillionCny"
      | "outputPerMillionCny"
      | "cachedInputPerMillionCny",
    value: string,
  ) => void;
  onAddRoleFallback: (role: Role) => void;
  onUpdateRoleFallback: (
    role: Role,
    index: number,
    patch: Partial<ModelSelection>,
  ) => void;
  onRemoveRoleFallback: (role: Role, index: number) => void;
}

export function RoleModelsPanel(props: RoleModelsPanelProps) {
  const { providers, models } = props;
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>角色模型</h2>
          <p>每个角色选择一个模型，三个角色可以使用同一模型或不同模型。</p>
        </div>
      </div>
      <div className="role-grid">
        {(Object.keys(roleMeta) as Role[]).map((role) => {
          const selection = models[role];
          const provider = providers.find(
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
                    props.onSelectRoleProvider(role, event.target.value)
                  }
                >
                  {providers
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
                    props.onUpdateRole(role, { model: event.target.value })
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
                      value={selection.pricing?.inputPerMillionCny ?? 0}
                      onChange={(event) =>
                        props.onUpdateRolePricing(
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
                      value={selection.pricing?.outputPerMillionCny ?? 0}
                      onChange={(event) =>
                        props.onUpdateRolePricing(
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
                      value={selection.pricing?.cachedInputPerMillionCny ?? 0}
                      onChange={(event) =>
                        props.onUpdateRolePricing(
                          role,
                          "cachedInputPerMillionCny",
                          event.target.value,
                        )
                      }
                    />
                  </label>
                </div>
                <div className="fallback-list">
                  {(selection.fallbacks ?? []).map((fallback, fallbackIndex) => {
                    const fallbackProvider = providers.find(
                      (item) => item.id === fallback.providerId,
                    );
                    return (
                      <div className="fallback-row" key={fallbackIndex}>
                        <span>{fallbackIndex + 1}</span>
                        <select
                          value={fallback.providerId}
                          onChange={(event) => {
                            const nextProvider = providers.find(
                              (item) => item.id === event.target.value,
                            );
                            props.onUpdateRoleFallback(role, fallbackIndex, {
                              providerId: event.target.value,
                              model: nextProvider?.models[0] ?? "",
                            });
                          }}
                        >
                          {providers
                            .filter((item) => item.enabled)
                            .map((item) => (
                              <option value={item.id} key={item.id}>
                                {item.name}
                              </option>
                            ))}
                        </select>
                        <select
                          value={fallback.model}
                          onChange={(event) =>
                            props.onUpdateRoleFallback(role, fallbackIndex, {
                              model: event.target.value,
                            })
                          }
                        >
                          {(fallbackProvider?.models ?? []).map((model) => (
                            <option value={model} key={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() =>
                            props.onRemoveRoleFallback(role, fallbackIndex)
                          }
                        >
                          删除
                        </button>
                      </div>
                    );
                  })}
                  <button
                    className="add-fallback-button"
                    onClick={() => props.onAddRoleFallback(role)}
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
  );
}
