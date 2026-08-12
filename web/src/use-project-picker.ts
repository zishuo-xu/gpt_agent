import { useState } from "react";

export interface FsRoot {
  name: string;
  path: string;
}

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** 目录选择器打开的项目信息（/api/projects/open 响应） */
export interface OpenedProject {
  key: string;
  name: string;
  cwd: string;
}

/**
 * 项目选择器数据逻辑：文件系统浏览（只读）+ 打开项目。
 * fs 状态自包含；打开成功后通过 onOpened 回调交给上层切换会话视图。
 */
export function useProjectPicker(options: {
  onOpened: (project: OpenedProject) => void;
}) {
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [fsRoots, setFsRoots] = useState<FsRoot[]>([]);
  const [fsPath, setFsPath] = useState("");
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([]);
  const [fsError, setFsError] = useState("");
  const [fsOpening, setFsOpening] = useState(false);

  // 面板展开后聚焦输入框（模态居中，无需滚动）
  async function openProjectPicker() {
    setFsError("");
    setShowProjectPicker(true);
    try {
      const rootsResponse = await fetch("/api/fs/roots");
      const rootsPayload = await rootsResponse.json();
      const roots = (rootsPayload.roots ?? []) as FsRoot[];
      setFsRoots(roots);
      // 从第一个根（家目录）开始浏览
      const first = roots[0];
      if (first) {
        setFsPath(first.path);
        await loadFsDirectory(first.path);
      }
    } catch {
      setFsError("无法读取目录列表");
    }
  }

  async function loadFsDirectory(dir: string) {
    setFsError("");
    setFsPath(dir);
    const response = await fetch(
      `/api/fs/list?path=${encodeURIComponent(dir)}`,
    );
    const payload = await response.json();
    if (!response.ok) {
      setFsError(payload.error ?? "读取目录失败");
      setFsEntries([]);
      return;
    }
    setFsEntries((payload.entries ?? []) as FsEntry[]);
  }

  async function confirmOpenProject(dir: string) {
    setFsOpening(true);
    setFsError("");
    try {
      const response = await fetch("/api/projects/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dir }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setFsError(payload.error ?? "无法打开项目");
        return;
      }
      setShowProjectPicker(false);
      options.onOpened(payload.project as OpenedProject);
    } catch {
      setFsError("无法打开项目");
    } finally {
      setFsOpening(false);
    }
  }

  return {
    showProjectPicker,
    fsRoots,
    fsPath,
    fsEntries,
    fsError,
    fsOpening,
    openProjectPicker,
    loadFsDirectory,
    confirmOpenProject,
    closeProjectPicker: () => setShowProjectPicker(false),
  };
}
