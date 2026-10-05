import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { compareCaptures } from "@shadowcheck/comparison";

describe("real HTTP replay fixture", () => {
  it("compares real baseline and candidate responses", async () => {
    const baseline = createServer((_request, response) => response.end(JSON.stringify({ id: 1, plan: "PRO" })));
    const candidate = createServer((_request, response) => response.end(JSON.stringify({ id: 1 })));
    await Promise.all([new Promise<void>((resolve) => baseline.listen(0, resolve)), new Promise<void>((resolve) => candidate.listen(0, resolve))]);
    try {
      const a = await fetch(`http://127.0.0.1:${(baseline.address() as any).port}/user`); const b = await fetch(`http://127.0.0.1:${(candidate.address() as any).port}/user`);
      const result = compareCaptures({ statusCode: a.status, headers: {}, body: await a.json(), durationMs: 5, contentType: "application/json", truncated: false, errorCode: null }, { statusCode: b.status, headers: {}, body: await b.json(), durationMs: 5, contentType: "application/json", truncated: false, errorCode: null }, { failOnStatusChange: true, failOnRemovedFields: true, failOnTypeChange: true, latencyWarningPercent: 20, latencyFailurePercent: 50, latencyMinimumMs: 100, selectedResponseHeaders: [] });
      expect(result.result).toBe("REGRESSION"); expect(result.differences[0].path).toBe("$.plan");
    } finally { await Promise.all([new Promise<void>((resolve, reject) => baseline.close((error) => error ? reject(error) : resolve())), new Promise<void>((resolve, reject) => candidate.close((error) => error ? reject(error) : resolve()))]); }
  });
});
