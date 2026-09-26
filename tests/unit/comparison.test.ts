import { describe, expect, it } from "vitest";
import { compareCaptures, deriveStructuralSchema, validateOpenApiResponse } from "@shadowcheck/comparison";
import type { HttpCapture } from "@shadowcheck/contracts";

const policy = { failOnStatusChange: true, failOnRemovedFields: true, failOnTypeChange: true, latencyWarningPercent: 20, latencyFailurePercent: 50, latencyMinimumMs: 100, selectedResponseHeaders: [] };
const capture = (body: unknown, durationMs = 120, statusCode = 200): HttpCapture => ({ statusCode, headers: {}, body, durationMs, contentType: "application/json", truncated: false, errorCode: null });
describe("comparison engine", () => {
  it("reports added, removed, nested, type, and array differences", () => {
    const result = compareCaptures(capture({ id: 1, removed: true, nested: { amount: 4 }, items: [1, 2] }), capture({ id: 1, added: true, nested: { amount: "4" }, items: [1] }), policy);
    expect(result.result).toBe("REGRESSION");
    expect(result.differences.map((difference) => [difference.path, difference.type])).toEqual(expect.arrayContaining([["$.removed", "FIELD_REMOVED"], ["$.added", "FIELD_ADDED"], ["$.nested.amount", "TYPE_CHANGED"], ["$.items", "ARRAY_LENGTH_CHANGED"]]));
  });
  it("ignores dynamic fields and treats null as distinct from a missing value", () => {
    const ignored = compareCaptures(capture({ id: 1, requestId: "a" }), capture({ id: 1, requestId: "b" }), { ...policy, ignorePaths: ["$.requestId"] });
    expect(ignored.result).toBe("PASS");
    const missing = compareCaptures(capture({ value: null }), capture({}), policy);
    expect(missing.differences[0]).toMatchObject({ path: "$.value", type: "FIELD_REMOVED" });
  });
  it("classifies latency using configured thresholds", () => {
    expect(compareCaptures(capture({ ok: true }, 100), capture({ ok: true }, 125), policy).result).toBe("WARNING");
    expect(compareCaptures(capture({ ok: true }, 100), capture({ ok: true }, 170), policy).result).toBe("REGRESSION");
  });
  it("uses a simplified schema for OpenAPI validation", () => {
    const document = {
      openapi: "3.0.0",
      paths: {
        "/users/{id}": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "number" } } } } } }
            }
          }
        }
      }
    };
    expect(validateOpenApiResponse(document, "GET", "/users/1", 200, { id: "1" })).toHaveLength(1);
    expect(deriveStructuralSchema({ id: 1, tags: ["new"] })).toEqual({ type: "object", properties: { id: { type: "number" }, tags: { type: "array", items: { type: "string" } } } });
  });
});
