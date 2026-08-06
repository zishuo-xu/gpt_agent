import type { Config } from "./types";

export interface ContextPanelProps {
  context: Config["context"];
  description?: string;
  onChange: (recipe: (current: Config) => Config) => void;
}

export function ContextPanel(props: ContextPanelProps) {
  const { context } = props;
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>上下文</h2>
          <p>{props.description ?? "硬压缩阈值与保留轮数。"}</p>
        </div>
      </div>
      <div className="behavior-grid">
        <label>
          硬压缩触发（估算 tokens）
          <input
            type="number"
            min="1000"
            value={context.compactAtEstimatedTokens}
            onChange={(event) =>
              props.onChange((current) => ({
                ...current,
                context: {
                  ...current.context,
                  compactAtEstimatedTokens: Number(event.target.value),
                },
              }))
            }
          />
        </label>
        <label>
          压缩后保留最近 tokens
          <input
            type="number"
            min="1000"
            value={context.keepRecentTokens}
            onChange={(event) =>
              props.onChange((current) => ({
                ...current,
                context: {
                  ...current.context,
                  keepRecentTokens: Number(event.target.value),
                },
              }))
            }
          />
        </label>
      </div>
    </section>
  );
}
