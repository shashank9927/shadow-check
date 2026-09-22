import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  resolve: { alias: {
    "@shadowcheck/contracts": source("./packages/contracts/src/index.ts"),
    "@shadowcheck/comparison": source("./packages/comparison/src/index.ts"),
    "@shadowcheck/redaction": source("./packages/redaction/src/index.ts"),
    "@shadowcheck/shared": source("./packages/shared/src/index.ts")
  } },
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 15000 }
});
