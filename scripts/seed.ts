import { readFile } from "node:fs/promises";
import "dotenv/config";
import { Prisma, prisma, closeDatabase } from "@shadowcheck/database";
import { trafficRequestSchema } from "@shadowcheck/contracts";
import { sanitizeTrafficRequest } from "@shadowcheck/redaction";

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const traffic = trafficRequestSchema.array().parse(JSON.parse(await readFile(new URL("../fixtures/sample-traffic.json", import.meta.url), "utf8")));
const project = await prisma.project.upsert({
  where: { id: "demo-commerce-api" },
  create: {
    id: "demo-commerce-api", name: "Demo Commerce API", description: "Included fixture APIs with deliberate API regressions.", maxConcurrency: 3, requestsPerSecond: 10, allowWriteMethods: true,
    environments: { create: [
      { type: "BASELINE", baseUrl: process.env.DEMO_BASELINE_URL ?? "http://baseline:3001", timeoutMs: 5000, headers: {} },
      { type: "CANDIDATE", baseUrl: process.env.DEMO_CANDIDATE_URL ?? "http://candidate:3002", timeoutMs: 5000, headers: {} }
    ] },
    regressionPolicy: { create: { latencyWarningPercent: 20, latencyFailurePercent: 50, latencyMinimumMs: 100 } },
    redactionRules: { create: [{ headerName: "Authorization", action: "REDACT" }, { jsonPath: "$.email", action: "REDACT" }] },
    ignoreRules: { create: [{ jsonPath: "$.requestId" }, { jsonPath: "$.timestamp" }] }
  },
  update: {}
});
const rules = [{ headerName: "Authorization", action: "REDACT" as const }, { jsonPath: "$.email", action: "REDACT" as const }];
const count = await prisma.trafficRequest.count({ where: { projectId: project.id } });
if (!count) { const sanitized = traffic.map((item) => sanitizeTrafficRequest(item, rules)); await prisma.trafficRequest.createMany({ data: sanitized.map((item) => ({ projectId: project.id, name: item.name, method: item.method, path: item.path, headers: asJson(item.headers), body: item.body === undefined ? Prisma.JsonNull : asJson(item.body), query: item.query ? asJson(item.query) : Prisma.JsonNull })) }); }
console.log(`Seeded ${project.name}.`); await closeDatabase();
