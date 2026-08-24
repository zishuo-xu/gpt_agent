import type { AgentTurnTrace } from "./events.js";
import type { ExperimentSessionMeta } from "./experiment.js";

export interface ExperimentRunSummary {
  status?: string;
  reason?: string;
  totalCostCny?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  acceptance?: {
    status?: string;
    attempts?: number;
    checks?: readonly unknown[];
    review?: { passed?: boolean; issues?: readonly string[]; summary?: string };
  };
  review?: { passed?: boolean; issues?: readonly string[]; summary?: string };
}

export interface ExperimentRunSnapshot {
  meta: ExperimentSessionMeta;
  traces?: readonly AgentTurnTrace[];
  summary?: ExperimentRunSummary;
}

export interface NormalizedToolCall {
  index: number;
  tool: string;
  target: string;
  key: string;
}

export interface ExperimentDiff {
  model: { parent: string; child: string; changed: boolean };
  overlay: { parent: string; child: string; changed: boolean };
  turns: { parent: number; child: number; delta: number };
  durationMs: { parent: number; child: number; delta: number };
  tools: {
    parent: number;
    child: number;
    parentSequence: string[];
    childSequence: string[];
    firstDivergence?: {
      parent?: NormalizedToolCall;
      child?: NormalizedToolCall;
      index: number;
    };
  };
  tokens: {
    parent: { input: number; output: number; cached: number };
    child: { input: number; output: number; cached: number };
    delta: { input: number; output: number; cached: number };
  };
  costCny: { parent: number; child: number; delta: number };
  status: { parent?: string; child?: string; changed: boolean };
  acceptance?: { parent?: unknown; child?: unknown; changed: boolean };
  review?: { parent?: unknown; child?: unknown; changed: boolean };
}

function modelKey(meta: ExperimentSessionMeta): string {
  return `${meta.pinnedModel.providerId}/${meta.pinnedModel.model}`;
}

function normalizeToolTarget(tool: string, target: string): string {
  return `${tool.trim().toLowerCase()}+${target.trim().replace(/\\/g, "/").replace(/\s+/g, " ")}`;
}

export function normalizedToolCalls(
  traces: readonly AgentTurnTrace[] = [],
): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = [];
  for (const trace of traces) {
    for (const item of trace.tools ?? []) {
      const tool = typeof item.call?.tool === "string" ? item.call.tool : "";
      const target = typeof item.call?.target === "string" ? item.call.target : "";
      calls.push({ index: calls.length, tool, target, key: normalizeToolTarget(tool, target) });
    }
  }
  return calls;
}

function usage(traces: readonly AgentTurnTrace[], summary?: ExperimentRunSummary) {
  const result = { input: 0, output: 0, cached: 0 };
  for (const trace of traces) {
    result.input += trace.usage?.input ?? 0;
    result.output += trace.usage?.output ?? 0;
    result.cached += trace.usage?.cached ?? 0;
  }
  if (result.input === 0 && result.output === 0 && result.cached === 0) {
    result.input = summary?.totalInputTokens ?? 0;
    result.output = summary?.totalOutputTokens ?? 0;
  }
  return result;
}

function duration(traces: readonly AgentTurnTrace[]): number {
  return traces.reduce((total, trace) => total + (trace.durationMs ?? 0), 0);
}

function firstDivergence(parent: NormalizedToolCall[], child: NormalizedToolCall[]) {
  const length = Math.max(parent.length, child.length);
  for (let index = 0; index < length; index += 1) {
    if (parent[index]?.key !== child[index]?.key) {
      return { index, ...(parent[index] ? { parent: parent[index] } : {}), ...(child[index] ? { child: child[index] } : {}) };
    }
  }
  return undefined;
}

function changedValue(parent: unknown, child: unknown): boolean {
  return JSON.stringify(parent) !== JSON.stringify(child);
}

/** Pure, tolerant comparison of two experiment runs. */
export function computeExperimentDiff(
  parent: ExperimentRunSnapshot,
  child: ExperimentRunSnapshot,
): ExperimentDiff {
  const parentTraces = parent.traces ?? [];
  const childTraces = child.traces ?? [];
  const parentTools = normalizedToolCalls(parentTraces);
  const childTools = normalizedToolCalls(childTraces);
  const parentUsage = usage(parentTraces, parent.summary);
  const childUsage = usage(childTraces, child.summary);
  const parentCost = parent.summary?.totalCostCny ?? 0;
  const childCost = child.summary?.totalCostCny ?? 0;
  const parentAcceptance = parent.summary?.acceptance;
  const childAcceptance = child.summary?.acceptance;
  const parentReview = parent.summary?.review ?? parentAcceptance?.review;
  const childReview = child.summary?.review ?? childAcceptance?.review;
  const divergence = firstDivergence(parentTools, childTools);
  const parentDuration = duration(parentTraces);
  const childDuration = duration(childTraces);
  return {
    model: { parent: modelKey(parent.meta), child: modelKey(child.meta), changed: modelKey(parent.meta) !== modelKey(child.meta) },
    overlay: { parent: parent.meta.systemPromptOverlay ?? "", child: child.meta.systemPromptOverlay ?? "", changed: (parent.meta.systemPromptOverlay ?? "") !== (child.meta.systemPromptOverlay ?? "") },
    turns: { parent: parentTraces.length, child: childTraces.length, delta: childTraces.length - parentTraces.length },
    durationMs: {
      parent: parentDuration,
      child: childDuration,
      delta: childDuration - parentDuration,
    },
    tools: {
      parent: parentTools.length,
      child: childTools.length,
      parentSequence: parentTools.map((item) => item.key),
      childSequence: childTools.map((item) => item.key),
      ...(divergence ? { firstDivergence: divergence } : {}),
    },
    tokens: {
      parent: parentUsage,
      child: childUsage,
      delta: { input: childUsage.input - parentUsage.input, output: childUsage.output - parentUsage.output, cached: childUsage.cached - parentUsage.cached },
    },
    costCny: { parent: parentCost, child: childCost, delta: childCost - parentCost },
    status: {
      ...(parent.summary?.status === undefined ? {} : { parent: parent.summary.status }),
      ...(child.summary?.status === undefined ? {} : { child: child.summary.status }),
      changed: parent.summary?.status !== child.summary?.status,
    },
    ...(parentAcceptance || childAcceptance ? { acceptance: { parent: parentAcceptance, child: childAcceptance, changed: changedValue(parentAcceptance, childAcceptance) } } : {}),
    ...(parentReview || childReview ? { review: { parent: parentReview, child: childReview, changed: changedValue(parentReview, childReview) } } : {}),
  };
}
