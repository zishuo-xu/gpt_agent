/**
 * Redacts secrets from trace payloads before they cross the Web API boundary.
 * The operation is deliberately non-mutating and handles arbitrary JSON-ish
 * values (including circular values supplied by test doubles).
 */
const SECRET_KEY = /(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|passwd|secret|private[_-]?key|client[_-]?secret|x-api-key)/i;
const ENV_SECRET = /^(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)$/i;
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s"']+)/gi;

export function redactTrace<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (input: unknown, key?: string): unknown => {
    if (key && (SECRET_KEY.test(key) || ENV_SECRET.test(key))) {
      return "[REDACTED]";
    }
    if (typeof input === "string") {
      return input
        .replace(/((?:Bearer|Basic)\s+)[^\s]+/gi, "$1[REDACTED]")
        .replace(ENV_ASSIGNMENT, "$1=[REDACTED]")
        .replace(
          /\b(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
          "$1$2:[REDACTED]@",
        );
    }
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map((item) => visit(item));
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(input)) {
      output[childKey] = visit(childValue, childKey);
    }
    return output;
  };
  return visit(value) as T;
}
