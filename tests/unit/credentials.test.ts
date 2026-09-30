import { describe, expect, it } from "vitest";
import { credentialsFromHeaders } from "../../apps/api/src/credentials";

describe("environment credential handling", () => {
  it("separates encrypted credential candidates from ordinary headers", () => {
    expect(credentialsFromHeaders({ Authorization: "Bearer secret", Accept: "application/json", "X-API-Key": "key" })).toEqual({
      safeHeaders: { Accept: "application/json" },
      secrets: [{ headerName: "Authorization", value: "Bearer secret" }, { headerName: "X-API-Key", value: "key" }]
    });
  });
});
