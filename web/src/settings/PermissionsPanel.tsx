import type { Config } from "./types";

export interface PermissionsPanelProps {
  permissions: Config["permissions"];
  description?: string;
  onUpdatePermission: (patch: Partial<Config["permissions"]>) => void;
  onUpdateRule: (
    index: number,
    patch: Partial<Config["permissions"]["rules"][number]>,
  ) => void;
}

export function PermissionsPanel(props: PermissionsPanelProps) {
  const { permissions } = props;
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>权限与审批</h2>
          <p>
            {props.description ??
              "会话默认档位、规则与审批超时。"}
          </p>
        </div>
      </div>
      <div className="behavior-grid">
        <label>
          默认权限档
          <select
            value={permissions.mode}
            onChange={(event) =>
              props.onUpdatePermission({
                mode: event.target.value as Config["permissions"]["mode"],
              })
            }
          >
            <option value="strict">严格（写操作与命令都需批准）</option>
            <option value="normal">标准（只读自动放行，写与命令需批准）</option>
            <option value="trust">信任（除显式禁止外自动执行）</option>
          </select>
        </label>
        <label>
          审批超时（秒）
          <input
            type="number"
            min="1"
            value={Math.round(permissions.approvalTimeoutMs / 1000)}
            onChange={(event) =>
              props.onUpdatePermission({
                approvalTimeoutMs: Number(event.target.value) * 1000,
              })
            }
          />
        </label>
      </div>
      <div className="permission-rule-list">
        {permissions.rules.map((rule, index) => (
          <div className="permission-rule-row" key={index}>
            <select
              value={rule.effect}
              onChange={(event) =>
                props.onUpdateRule(index, {
                  effect: event.target.value as typeof rule.effect,
                })
              }
            >
              <option value="allow">允许</option>
              <option value="ask">询问</option>
              <option value="deny">禁止</option>
            </select>
            <input
              value={rule.pattern}
              onChange={(event) =>
                props.onUpdateRule(index, {
                  pattern: event.target.value,
                })
              }
              placeholder="Bash(git commit *)"
            />
            <button
              onClick={() =>
                props.onUpdatePermission({
                  rules: permissions.rules.filter(
                    (_, ruleIndex) => ruleIndex !== index,
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
            props.onUpdatePermission({
              rules: [
                ...permissions.rules,
                { effect: "ask", pattern: "Bash(command *)" },
              ],
            })
          }
        >
          ＋ 添加规则
        </button>
      </div>
    </section>
  );
}
