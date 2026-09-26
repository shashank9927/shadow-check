import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, joinTargetUrl, normaliseBaseUrl } from "@shadowcheck/shared";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
describe("replay safety", () => {
  it("keeps target paths on the configured origin", () => {
    expect(joinTargetUrl("https://api.example.com/v1", "/users/1").toString()).toBe("https://api.example.com/v1/users/1");
    expect(() => joinTargetUrl("https://api.example.com", "//metadata.internal")).toThrow("absolute path");
    expect(() => normaliseBaseUrl("file:///etc/passwd")).toThrow("Only HTTP");
  });
  it("encrypts credentials without retaining plaintext", () => {
    const encrypted = encryptSecret("Bearer only-in-memory", key);
    expect(encrypted).not.toContain("only-in-memory");
    expect(decryptSecret(encrypted, key)).toBe("Bearer only-in-memory");
  });
});
