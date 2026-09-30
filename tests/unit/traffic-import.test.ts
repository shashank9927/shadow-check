import { describe, expect, it } from "vitest";
import { convertHar } from "../../apps/api/src/import";

describe("HAR traffic conversion", () => {
  it("extracts replay-safe request fields from a HAR entry", () => {
    expect(convertHar({ log: { entries: [{ request: { method: "POST", url: "https://api.example.test/orders?page=2", headers: [{ name: "Content-Type", value: "application/json" }], queryString: [{ name: "page", value: "2" }], postData: { text: "{\"quantity\":2}" } } }] } })).toEqual([{ name: "POST /orders", method: "POST", path: "/orders", headers: { "Content-Type": "application/json" }, query: { page: "2" }, body: { quantity: 2 } }]);
  });
});
