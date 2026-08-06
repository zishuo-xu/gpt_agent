interface FsRoot {
  name: string;
  path: string;
}

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface ProjectPickerProps {
  roots: FsRoot[];
  path: string;
  entries: FsEntry[];
  error: string;
  opening: boolean;
  onNavigate: (dir: string) => void;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * 「打开其他项目」目录选择器（纯展示 + 回调）。
 * 根入口 / 面包屑 / 目录列表均为可点击导航；底部按钮确认打开当前目录。
 */
export function ProjectPicker(props: ProjectPickerProps) {
  return (
    <div
      className="project-picker-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
    >
      <div className="project-picker">
        <div className="project-picker-head">
          <h2>打开其他项目</h2>
          <button
            type="button"
            className="project-picker-close"
            aria-label="关闭"
            onClick={props.onClose}
          >
            ×
          </button>
        </div>
        <div className="project-picker-breadcrumbs">
          {props.roots.map((root) => (
            <button
              key={root.path}
              className={
                props.path === root.path ||
                props.path.startsWith(root.path + "/")
                  ? "active"
                  : ""
              }
              onClick={() => props.onNavigate(root.path)}
            >
              {root.name === root.path
                ? root.path
                : `${root.name}（${root.path}）`}
            </button>
          ))}
          {props.path
            .split("/")
            .filter(Boolean)
            .map((segment, index, array) => {
              const path = "/" + array.slice(0, index + 1).join("/");
              return (
                <button
                  key={path}
                  className={path === props.path ? "active" : ""}
                  onClick={() => props.onNavigate(path)}
                >
                  {segment}
                </button>
              );
            })}
        </div>
        <div className="project-picker-path">{props.path}</div>
        {props.error && (
          <div className="project-picker-error">{props.error}</div>
        )}
        <div className="project-picker-list">
          {props.entries.length === 0 ? (
            <div className="project-picker-empty">
              没有可打开的子目录
            </div>
          ) : (
            props.entries.map((entry) => (
              <button
                key={entry.path}
                className="project-picker-entry"
                onClick={() => props.onNavigate(entry.path)}
              >
                <span>📁</span>
                {entry.name}
              </button>
            ))
          )}
        </div>
        <div className="project-picker-foot">
          <button
            className="project-picker-open"
            disabled={props.opening || !props.path}
            onClick={props.onOpen}
          >
            {props.opening ? "打开中…" : "打开此目录"}
          </button>
        </div>
      </div>
    </div>
  );
}
