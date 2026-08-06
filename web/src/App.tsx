import { useEffect, useMemo, useState } from "react";
import { SettingsSidebar } from "./SettingsSidebar";
import type {
  ConfigFieldSchema as SchemaField,
  ConnectionTestResult as TestResult,
} from "@shared/types.js";
import type { Config, ModelSelection, Provider, Role, Scope } from "./settings/types";
import { ProviderPanel } from "./settings/ProviderPanel";
import { RoleModelsPanel } from "./settings/RoleModelsPanel";
import { PermissionsPanel } from "./settings/PermissionsPanel";
import { ContextPanel } from "./settings/ContextPanel";
import { SchemaDrivenSections } from "./settings/SchemaSections";

export function App() {
  const [scope, setScope] = useState<Scope>("global");
  const [config, setConfig] = useState<Config | null>(null);
  const [schema, setSchema] = useState<SchemaField[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [revealedKey, setRevealedKey] = useState(false);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [notice, setNotice] = useState<{
    tone: "ok" | "warn" | "error";
    text: string;
  } | null>(null);
  const [projectKeyOverrides, setProjectKeyOverrides] = useState<{
    cwd: string;
    configPath: string;
    providers: Array<{ id: string; name: string }>;
  } | null>(null);

  useEffect(() => {
    document.title = "模型设置 · MyAgent";
    void fetch("/api/config/schema")
      .then((response) => response.json())
      .then((payload) => setSchema(payload.fields ?? []));
    void fetch("/api/config/key-overrides")
      .then((response) => response.json())
      .then((payload) => setProjectKeyOverrides(payload.project ?? null))
      .catch(() => setProjectKeyOverrides(null));
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
        setDirty(false);
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setNotice({ tone: "error", text: error.message });
        }
      })
      .finally(() => {
        // 切换 scope 中止旧请求时，不清掉新请求的 loading 状态
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [scope]);

  // 成功提示 4 秒后自动消失
  useEffect(() => {
    if (notice?.tone !== "ok") return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

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

  function replaceConfig(recipe: (current: Config) => Config) {
    setNotice(null);
    setDirty(true);
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
              (selection) => selection.providerId !== provider.id,
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
            (selection) => selection.providerId !== removed?.id,
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
                ? { ...fallback, model: nextModels[0] ?? "" }
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
      const incoming = config;
      const response = await fetch(`/api/config?scope=${scope}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(incoming),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error((payload.issues ?? [payload.error]).join("；"));
      }
      setConfig(payload.config);
      setDirty(false);
      if (!options.quiet) {
        const overridden = projectKeyOverrides?.providers.filter(
          (override) =>
            incoming.providers.some(
              (provider) =>
                provider.id === override.id &&
                provider.apiKey.trim() !== "",
            ),
        );
        if (scope === "global" && overridden && overridden.length > 0) {
          setNotice({
            tone: "warn",
            text:
              `已保存，但当前项目（${projectKeyOverrides!.cwd}）的 local.jsonc 中 ` +
              `${overridden.map((item) => item.name || item.id).join("、")} ` +
              "已配置非空 API Key，会覆盖此全局 Key。如需全局 Key 生效，请清空项目 Key。",
          });
        } else {
          setNotice({ tone: "ok", text: "配置已保存。" });
        }
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
      <SettingsSidebar active="settings" />

      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">SETTINGS / MODELS</p>
            <h1>模型设置</h1>
            <p>管理模型供应商，并为每个模型独立验证连接状态。</p>
          </div>
          <button
            className={`save-button${dirty ? " dirty" : ""}`}
            onClick={() => void save()}
            disabled={saving || loading}
            title={dirty ? "有未保存的更改" : undefined}
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
            <ProviderPanel
              providers={config.providers}
              selectedProviderId={selectedProviderId}
              selectedIndex={selectedIndex}
              scope={scope}
              projectKeyOverrides={projectKeyOverrides}
              revealedKey={revealedKey}
              saving={saving}
              testingKey={testingKey}
              testResults={testResults}
              onSelectProvider={setSelectedProviderId}
              onResetRevealedKey={() => setRevealedKey(false)}
              onToggleRevealedKey={() => setRevealedKey((value) => !value)}
              onAddProvider={addProvider}
              onRemoveProvider={removeProvider}
              onToggleProvider={toggleProvider}
              onUpdateProvider={updateProvider}
              onUpdateModel={updateModel}
              onAddModel={addModel}
              onRemoveModel={removeModel}
              onTestConnection={testConnection}
              providerDescription={providerDescription}
            />

            <RoleModelsPanel
              providers={config.providers}
              models={config.models}
              onSelectRoleProvider={selectRoleProvider}
              onUpdateRole={updateRole}
              onUpdateRolePricing={updateRolePricing}
              onAddRoleFallback={addRoleFallback}
              onUpdateRoleFallback={updateRoleFallback}
              onRemoveRoleFallback={removeRoleFallback}
            />

            <PermissionsPanel
              permissions={config.permissions}
              description={schema.find((field) => field.key === "permissions")?.description}
              onUpdatePermission={updatePermission}
              onUpdateRule={updateRule}
            />

            <ContextPanel
              context={config.context}
              description={schema.find((field) => field.key === "context")?.description}
              onChange={replaceConfig}
            />

            <SchemaDrivenSections schema={schema} config={config} onChange={replaceConfig} />
          </div>
        )}
      </main>
    </div>
  );
}
