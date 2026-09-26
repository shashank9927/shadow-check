import type { ComparisonDifference, ComparisonOptions, ComparisonOutput, HttpCapture, Severity } from "@shadowcheck/contracts";

const typeName = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const isIgnored = (path: string, paths: string[]) => paths.includes(path);
function add(differences: ComparisonDifference[], path: string, type: ComparisonDifference["type"], severity: Severity, baseline: unknown, candidate: unknown, message: string): void {
  differences.push({ path, type, severity, baseline, candidate, message });
}

function compareJson(baseline: unknown, candidate: unknown, path: string, options: ComparisonOptions, differences: ComparisonDifference[]): void {
  if (isIgnored(path, options.ignorePaths ?? [])) return;
  const baselineType = typeName(baseline);
  const candidateType = typeName(candidate);
  if (baselineType !== candidateType) {
    add(differences, path, "TYPE_CHANGED", "BREAKING", baseline, candidate, `Type changed from ${baselineType} to ${candidateType}.`);
    return;
  }
  if (baselineType === "array") {
    const left = baseline as unknown[]; const right = candidate as unknown[];
    if (left.length !== right.length) add(differences, path, "ARRAY_LENGTH_CHANGED", "WARNING", left.length, right.length, `Array length changed from ${left.length} to ${right.length}.`);
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) compareJson(left[index], right[index], `${path}[${index}]`, options, differences);
    return;
  }
  if (baselineType === "object" && baseline !== null && candidate !== null) {
    const left = baseline as Record<string, unknown>; const right = candidate as Record<string, unknown>;
    for (const key of Object.keys(left)) {
      const child = `${path}.${key}`;
      if (isIgnored(child, options.ignorePaths ?? [])) continue;
      if (!(key in right)) add(differences, child, "FIELD_REMOVED", "BREAKING", left[key], null, "Field was removed from the candidate response.");
      else compareJson(left[key], right[key], child, options, differences);
    }
    for (const key of Object.keys(right)) if (!(key in left) && !isIgnored(`${path}.${key}`, options.ignorePaths ?? [])) add(differences, `${path}.${key}`, "FIELD_ADDED", "INFO", null, right[key], "Field was added to the candidate response.");
    return;
  }
  if (!Object.is(baseline, candidate)) add(differences, path, "VALUE_CHANGED", "WARNING", baseline, candidate, "Value changed.");
}

export function compareCaptures(baseline: HttpCapture, candidate: HttpCapture, options: ComparisonOptions): ComparisonOutput {
  if (baseline.errorCode || candidate.errorCode || baseline.truncated || candidate.truncated) return {
    result: "ERROR", differences: [], errorCode: baseline.errorCode ?? candidate.errorCode ?? (baseline.truncated || candidate.truncated ? "RESPONSE_TOO_LARGE" : "UNKNOWN_ERROR")
  };
  const differences: ComparisonDifference[] = [];
  if (baseline.statusCode !== candidate.statusCode) add(differences, "$.status", "STATUS_CHANGED", "BREAKING", baseline.statusCode, candidate.statusCode, `Status changed from ${baseline.statusCode} to ${candidate.statusCode}.`);
  const wantedHeaders = options.selectedResponseHeaders.map((header) => header.toLowerCase());
  for (const header of wantedHeaders) if ((baseline.headers[header] ?? null) !== (candidate.headers[header] ?? null)) add(differences, `$.headers.${header}`, "HEADER_CHANGED", "WARNING", baseline.headers[header] ?? null, candidate.headers[header] ?? null, `Response header ${header} changed.`);
  if (baseline.body !== null && candidate.body !== null) compareJson(baseline.body, candidate.body, "$", options, differences);
  else if (baseline.rawBody !== candidate.rawBody) add(differences, "$.body", "VALUE_CHANGED", "WARNING", baseline.rawBody ?? null, candidate.rawBody ?? null, "Non-JSON response body changed.");
  const latencyDifference = candidate.durationMs - baseline.durationMs;
  const latencyPercent = baseline.durationMs === 0 ? (candidate.durationMs > 0 ? 100 : 0) : (latencyDifference / baseline.durationMs) * 100;
  if (baseline.durationMs >= options.latencyMinimumMs && latencyPercent >= options.latencyWarningPercent) {
    const severity: Severity = latencyPercent >= options.latencyFailurePercent ? "BREAKING" : "WARNING";
    add(differences, "$.latency", "LATENCY_REGRESSION", severity, baseline.durationMs, candidate.durationMs, `Candidate latency increased by ${latencyPercent.toFixed(1)}%.`);
  }
  const isBreaking = differences.some((difference) => difference.severity === "BREAKING");
  const isWarning = differences.some((difference) => difference.severity === "WARNING");
  return { result: isBreaking ? "REGRESSION" : isWarning ? "WARNING" : "PASS", differences, errorCode: null };
}

export function deriveStructuralSchema(value: unknown): unknown {
  if (Array.isArray(value)) return { type: "array", items: value.length ? deriveStructuralSchema(value[0]) : { type: "unknown" } };
  if (value && typeof value === "object") return { type: "object", properties: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, deriveStructuralSchema(child)])) };
  return { type: typeName(value) };
}

function resolveReference(document: Record<string, unknown>, value: any): any {
  if (!value?.$ref || typeof value.$ref !== "string") return value;
  const segments = value.$ref.replace(/^#\//, "").split("/");
  return segments.reduce((current: any, segment: string) => current?.[segment], document as any);
}
function pathOperation(document: Record<string, unknown>, method: string, requestPath: string): any {
  const paths = document.paths as Record<string, any> | undefined;
  if (!paths) return undefined;
  const exact = paths[requestPath];
  if (exact) return exact[method.toLowerCase()];
  const match = Object.entries(paths).find(([path]) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "[^/]+")}$`).test(requestPath));
  return match?.[1]?.[method.toLowerCase()];
}
function schemaProblems(document: Record<string, unknown>, schemaValue: any, value: unknown, path: string, problems: ComparisonDifference[]): void {
  const schema = resolveReference(document, schemaValue); if (!schema) return;
  const expected = schema.type as string | undefined;
  if (expected && typeName(value) !== expected) { add(problems, path, "OPENAPI_VIOLATION", "BREAKING", expected, typeName(value), `OpenAPI expects ${expected}, received ${typeName(value)}.`); return; }
  if (expected === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const field of schema.required ?? []) if (!(field in object)) add(problems, `${path}.${field}`, "OPENAPI_VIOLATION", "BREAKING", field, null, "Required OpenAPI response field is missing.");
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in object) schemaProblems(document, child, object[key], `${path}.${key}`, problems);
  }
  if (expected === "array" && Array.isArray(value)) value.forEach((child, index) => schemaProblems(document, schema.items, child, `${path}[${index}]`, problems));
}
export function validateOpenApiResponse(documentValue: unknown, method: string, requestPath: string, statusCode: number | null, body: unknown): ComparisonDifference[] {
  if (!documentValue || typeof documentValue !== "object" || !statusCode) return [];
  const document = documentValue as Record<string, unknown>; const operation = pathOperation(document, method, requestPath); const response = operation?.responses?.[String(statusCode)] ?? operation?.responses?.default;
  const fallbackContent = Object.values(response?.content ?? {}).find((content: any) => content?.schema) as { schema?: unknown } | undefined;
  const schema = response?.content?.["application/json"]?.schema ?? fallbackContent?.schema;
  const problems: ComparisonDifference[] = []; if (schema) schemaProblems(document, schema, body, "$", problems); return problems;
}
