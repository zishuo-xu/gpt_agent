import type { ConfigFieldSchema as SchemaField } from "@shared/types.js";
import { getConfigValue, setConfigValue } from "@shared/config-path.js";
import type { Config } from "./types";

const SCALAR_TYPES = ["string", "number", "boolean", "select"];

export function isScalarType(type: string): boolean {
  return SCALAR_TYPES.includes(type);
}

/**
 * 通用对象字段编辑器：schema 驱动的回退渲染器。
 * 新增复合配置项（未指定专用 renderer）时零前端改动即可显示并编辑其子字段。
 */
export function ObjectFieldEditor(props: {
  value: unknown;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const record =
    props.value && typeof props.value === "object" && !Array.isArray(props.value)
      ? (props.value as Record<string, unknown>)
      : {};
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return <p className="schema-field-note">该配置暂无子字段。</p>;
  }
  return (
    <div className="schema-field-grid">
      {keys.map((key) => {
        const value = record[key];
        const update = (next: unknown) =>
          props.onChange({ ...record, [key]: next });
        if (typeof value === "boolean") {
          return (
            <label className="schema-field" key={key}>
              <span>{key}</span>
              <input
                type="checkbox"
                checked={value}
                onChange={(event) => update(event.target.checked)}
              />
            </label>
          );
        }
        if (typeof value === "number") {
          return (
            <label className="schema-field" key={key}>
              <span>{key}</span>
              <input
                type="number"
                value={String(value)}
                onChange={(event) => update(Number(event.target.value))}
              />
            </label>
          );
        }
        if (typeof value === "string") {
          return (
            <label className="schema-field" key={key}>
              <span>{key}</span>
              <input
                type="text"
                value={value}
                onChange={(event) => update(event.target.value)}
              />
            </label>
          );
        }
        // 嵌套对象/数组等复杂结构：只读展示
        return (
          <label className="schema-field" key={key}>
            <span>{key}</span>
            <small>复杂结构，请在配置文件或对应功能区编辑。</small>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Schema 驱动面板：非标量复合字段的通用编辑器 + 标量字段的扩展设置区。
 * 新增配置项（未指定专用 renderer）时零前端改动即可显示并编辑。
 */
export function SchemaDrivenSections(props: {
  schema: SchemaField[];
  config: Config;
  onChange: (recipe: (current: Config) => Config) => void;
}) {
  const { schema, config } = props;
  const generatedFields = schema.filter((field) =>
    isScalarType(field.type),
  );
  const compoundFields = schema.filter(
    (field) => !isScalarType(field.type) && !field.renderer,
  );
  return (
    <>
      {compoundFields.map((field) => (
        <section className="panel" key={field.key}>
          <div className="section-heading">
            <div>
              <h2>
                {field.title}
                {field.hot && <em>即时生效</em>}
              </h2>
              <p>{field.description}</p>
            </div>
          </div>
          <ObjectFieldEditor
            value={config[field.key]}
            onChange={(value) =>
              props.onChange((current) => ({
                ...current,
                [field.key]: value,
              }))
            }
          />
        </section>
      ))}
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
              // dotted 键（server.host 等）读写嵌套 section，避免被后端静默丢弃
              const value =
                getConfigValue(config, field.key) ??
                field.default ??
                "";
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
                        props.onChange((current) =>
                          setConfigValue(
                            current,
                            field.key,
                            event.target.checked,
                          ),
                        )
                      }
                    />
                  ) : field.type === "select" ? (
                    <select
                      value={String(value)}
                      onChange={(event) =>
                        props.onChange((current) =>
                          setConfigValue(
                            current,
                            field.key,
                            event.target.value,
                          ),
                        )
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
                        props.onChange((current) =>
                          setConfigValue(
                            current,
                            field.key,
                            field.type === "number"
                              ? Number(event.target.value)
                              : event.target.value,
                          ),
                        )
                      }
                    />
                  )}
                </label>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
