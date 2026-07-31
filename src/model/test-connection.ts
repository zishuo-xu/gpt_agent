import type { ModelProviderConfig } from "../config/schema.js";

export interface ConnectionTestResult {
  ok: boolean;
  reachable: boolean;
  providerId: string;
  model: string;
  latencyMs: number;
  message: string;
}

export async function testModelConnection(
  provider: ModelProviderConfig,
  model: string,
  fetcher: typeof fetch = fetch,
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  if (!provider.apiKey) {
    return result(false, false, "尚未配置 API Key");
  }
  if (!provider.models.includes(model)) {
    return result(false, false, "测试模型不在该渠道的模型列表中");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  timeout.unref();

  try {
    const request = buildRequest(provider, model, controller.signal);
    const response = await fetcher(request.url, request.init);
    const body = await readResponseBody(response);
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      return {
        ok: true,
        reachable: true,
        providerId: provider.id,
        model,
        latencyMs,
        message: "连接成功，认证与模型调用均正常",
      };
    }
    return {
      ok: false,
      reachable: true,
      providerId: provider.id,
      model,
      latencyMs,
      message: classifyHttpError(response.status, body),
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const aborted =
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError");
    return {
      ok: false,
      reachable: false,
      providerId: provider.id,
      model,
      latencyMs,
      message: aborted
        ? "连接超时（15 秒）"
        : `无法连接：${error instanceof Error ? error.message : "未知网络错误"}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  function result(
    ok: boolean,
    reachable: boolean,
    message: string,
  ): ConnectionTestResult {
    return {
      ok,
      reachable,
      providerId: provider.id,
      model,
      latencyMs: Date.now() - startedAt,
      message,
    };
  }
}

function buildRequest(
  provider: ModelProviderConfig,
  model: string,
  signal: AbortSignal,
): { url: string; init: RequestInit } {
  const common: RequestInit = {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
  };

  if (provider.protocol === "anthropic") {
    return {
      url: appendEndpoint(provider.baseUrl, "messages"),
      init: {
        ...common,
        headers: {
          ...common.headers,
          "x-api-key": provider.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "Reply with OK." }],
        }),
      },
    };
  }

  return {
    url: appendEndpoint(provider.baseUrl, "chat/completions"),
    init: {
      ...common,
      headers: {
        ...common.headers,
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: "user", content: "Reply with OK." }],
      }),
    },
  };
}

function appendEndpoint(baseUrl: string, endpoint: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith(`/${endpoint}`)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/${endpoint}`;
  return `${normalized}/v1/${endpoint}`;
}

async function readResponseBody(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message ?? parsed.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

function classifyHttpError(status: number, detail: string): string {
  const suffix = detail ? `：${detail}` : "";
  if (status === 401 || status === 403) return `认证失败，请检查 API Key${suffix}`;
  if (status === 404) return `接口路径或模型不存在${suffix}`;
  if (status === 429) return `服务已响应，但当前限流或额度不足${suffix}`;
  if (status >= 500) return `服务端错误（${status}）${suffix}`;
  return `请求失败（HTTP ${status}）${suffix}`;
}
