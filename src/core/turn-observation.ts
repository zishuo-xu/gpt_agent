import type { AgentTurnTrace } from "./events.js";
import type { WorkspaceFingerprint } from "./workspace-fingerprint.js";

const PREVIEW = 160;

/** Stable readout of one recorded turn. Derived, never a new execution. */
export interface TurnObservation {
  saw: { messages: number; lastUser?: string };
  decided: { text?: string; tools: string[] };
  did: Array<{ tool: string; target: string; permission: string; outcome: "success" | "error" | "denied" | "aborted" | "unknown" }>;
  workspace?: WorkspaceFingerprint;
}

export function observeTurn(trace: AgentTurnTrace): TurnObservation {
  const request = isRecord(trace.request) ? trace.request : undefined;
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const lastUser = [...messages]
    .reverse()
    .find(
      (message) =>
        isRecord(message) &&
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.trim(),
    );
  const response = isRecord(trace.response) ? trace.response : undefined;
  const decidedFromResponse = Array.isArray(response?.toolCalls)
    ? response.toolCalls
        .map((call) =>
          isRecord(call) && typeof call.tool === "string" ? call.tool : "",
        )
        .filter(Boolean)
    : [];
  const did = (trace.tools ?? []).map((item) => ({
    tool: typeof item.call?.tool === "string" ? item.call.tool : "",
    target: typeof item.call?.target === "string" ? item.call.target : "",
    permission: typeof item.permission === "string" ? item.permission : "",
    outcome: toolOutcome(item),
  }));
  const text =
    typeof response?.text === "string" && response.text.trim()
      ? preview(response.text)
      : undefined;
  return {
    saw: {
      messages: messages.length,
      ...(typeof lastUser?.content === "string"
        ? { lastUser: preview(lastUser.content) }
        : {}),
    },
    decided: {
      ...(text === undefined ? {} : { text }),
      tools: decidedFromResponse.length
        ? decidedFromResponse
        : did.map((step) => step.tool).filter(Boolean),
    },
    did,
    ...(trace.workspace ? { workspace: trace.workspace } : {}),
  };
}

function toolOutcome(item: AgentTurnTrace["tools"][number]): "success" | "error" | "denied" | "aborted" | "unknown" {
  const permission = item.permission.toLowerCase();
  if (permission === "deny" || permission === "denied" || permission === "user_denied" || permission === "phase_deny" || permission === "task_box_deny") return "denied";
  const result = isRecord(item.result) ? item.result : undefined;
  if (result?.aborted === true || result?.steered === true) return "aborted";
  if (result?.isError === true || "error" in (result ?? {})) return "error";
  if (item.result !== undefined) return "success";
  return "unknown";
}

function preview(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= PREVIEW ? trimmed : `${trimmed.slice(0, PREVIEW)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
