import type { RedactionRuleInput, TrafficRequestInput } from "@shadowcheck/contracts";

export const REDACTED_VALUE = "[REDACTED]";
export const BUILT_IN_SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);

type JsonRule = Pick<RedactionRuleInput, "jsonPath" | "action">;
function tokenise(path: string): Array<string | number | "*"> {
  const tokens: Array<string | number | "*"> = [];
  const matcher = /(?:\.([A-Za-z_$][\w$-]*))|(?:\[(\d+|\*)\])/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(path))) tokens.push(match[1] ?? (match[2] === "*" ? "*" : Number(match[2])));
  return tokens;
}
function applyAt(node: unknown, tokens: Array<string | number | "*">, action: "REDACT" | "REMOVE"): void {
  if (!node || typeof node !== "object" || tokens.length === 0) return;
  const [head, ...rest] = tokens;
  const object = node as Record<string, unknown>;
  const keys = head === "*" ? Object.keys(object) : [String(head)];
  for (const key of keys) {
    if (!(key in object)) continue;
    if (rest.length === 0) {
      if (action === "REMOVE") {
        if (Array.isArray(node)) node.splice(Number(key), 1); else delete object[key];
      } else object[key] = REDACTED_VALUE;
    } else applyAt(object[key], rest, action);
  }
}

export function redactJson<T>(value: T, rules: JsonRule[]): T {
  if (value === undefined) return value;
  const copy = structuredClone(value);
  for (const rule of rules) if (rule.jsonPath) applyAt(copy, tokenise(rule.jsonPath), rule.action);
  return copy;
}

export function redactHeaders(headers: Record<string, string>, customHeaderNames: string[] = []): Record<string, string> {
  const sensitive = new Set([...BUILT_IN_SENSITIVE_HEADERS, ...customHeaderNames.map((header) => header.toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, sensitive.has(name.toLowerCase()) ? REDACTED_VALUE : value]));
}

export function sanitizeTrafficRequest(input: TrafficRequestInput, rules: RedactionRuleInput[]): TrafficRequestInput {
  const headerNames = rules.flatMap((rule) => rule.headerName ? [rule.headerName] : []);
  const jsonRules = rules.filter((rule): rule is RedactionRuleInput & { jsonPath: string } => Boolean(rule.jsonPath));
  return { ...input, headers: redactHeaders(input.headers ?? {}, headerNames), body: redactJson(input.body, jsonRules) };
}
