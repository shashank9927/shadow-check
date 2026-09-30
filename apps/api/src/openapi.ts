import YAML from "yaml";

function hasExternalRef(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasExternalRef);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => key === "$ref" && typeof child === "string" && !child.startsWith("#/") || hasExternalRef(child));
}
export function parseOpenApi(input: unknown, format: "json" | "yaml"): Record<string, unknown> {
  let parsed: unknown = input;
  if (typeof input === "string") parsed = format === "yaml" ? YAML.parse(input) : JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OpenAPI document must be an object.");
  const document = parsed as Record<string, unknown>;
  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.")) throw new Error("Only OpenAPI 3 documents are supported.");
  if (hasExternalRef(document)) throw new Error("External OpenAPI references are not supported.");
  return document;
}
