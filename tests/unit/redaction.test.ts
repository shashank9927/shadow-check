import { describe, expect, it } from "vitest";
import { redactHeaders, redactJson, sanitizeTrafficRequest, REDACTED_VALUE } from "@shadowcheck/redaction";

describe("redaction", () => {
  it("masks built-in and configured headers", () => {
    expect(redactHeaders({ Authorization: "Bearer secret", Cookie: "a=b", Accept: "application/json", "X-Private": "secret" }, ["X-Private"])).toEqual({ Authorization: REDACTED_VALUE, Cookie: REDACTED_VALUE, Accept: "application/json", "X-Private": REDACTED_VALUE });
  });
  it("redacts nested values, array values, and safely ignores missing paths", () => {
    const value = { user: { email: "anna@example.com", cards: [{ number: "4111" }, { number: "4222" }] } };
    const redacted = redactJson(value, [{ jsonPath: "$.user.email", action: "REDACT" }, { jsonPath: "$.user.cards[*].number", action: "REMOVE" }, { jsonPath: "$.missing.value", action: "REDACT" }]);
    expect(redacted).toEqual({ user: { email: REDACTED_VALUE, cards: [{}, {}] } });
    expect(value.user.email).toBe("anna@example.com");
  });
  it("sanitizes a traffic record before it can be persisted", () => {
    const record = sanitizeTrafficRequest({ method: "POST", path: "/orders", headers: { "X-API-Key": "key" }, body: { email: "anna@example.com" } }, [{ headerName: "X-API-Key", action: "REDACT" }, { jsonPath: "$.email", action: "REDACT" }]);
    expect(record).toEqual({ method: "POST", path: "/orders", headers: { "X-API-Key": REDACTED_VALUE }, body: { email: REDACTED_VALUE } });
  });
});
