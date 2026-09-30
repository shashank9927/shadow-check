import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { Prisma, EnvironmentType, RedactionAction } from "@shadowcheck/database";
import { prisma } from "@shadowcheck/database";
import {
  createProjectSchema, ignoreRuleInputSchema, paginationSchema,
  redactionRuleInputSchema, regressionPolicySchema, trafficRequestSchema, updateProjectSchema
} from "@shadowcheck/contracts";
import type { RedactionRuleInput, TrafficRequestInput } from "@shadowcheck/contracts";
import { sanitizeTrafficRequest } from "@shadowcheck/redaction";
import { assertSafeTarget, encryptSecret, normaliseBaseUrl, readEnv } from "@shadowcheck/shared";
import type { AppEnv } from "@shadowcheck/shared";
import { z, ZodError } from "zod";
import { ApiError, sendError } from "./errors.js";
import { credentialsFromHeaders } from "./credentials.js";
import { convertHar } from "./import.js";
import { parseOpenApi } from "./openapi.js";
import { createRedis, createReplayQueue, type ReplayJobData } from "./queue.js";

type Dependencies = { env?: AppEnv };
const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const cursorPage = async <T extends { id: string }>(find: (args: { take: number; skip?: number; cursor?: { id: string } }) => Promise<T[]>, cursor: string | undefined, limit: number) => {
  const rows = await find({ take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const next = rows.length > limit ? rows.pop()?.id ?? null : null;
  return { data: rows, nextCursor: next };
};

function ruleToInput(rule: { headerName: string | null; jsonPath: string | null; action: RedactionAction }): RedactionRuleInput {
  return { ...(rule.headerName ? { headerName: rule.headerName } : { jsonPath: rule.jsonPath! }), action: rule.action };
}
function projectView(project: any) {
  return { ...project, environments: project.environments?.map(({ credentials: _credentials, ...environment }: any) => environment) };
}

export async function buildServer(dependencies: Dependencies = {}): Promise<FastifyInstance> {
  const env = dependencies.env ?? readEnv();
  const redis = createRedis(env.REDIS_URL);
  const replayQueue = createReplayQueue(redis);
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, bodyLimit: env.MAX_IMPORT_FILE_BYTES, genReqId: (request) => request.headers["x-request-id"]?.toString() ?? randomUUID() });
  await app.register(cors, { origin: env.NODE_ENV === "production" ? false : true });
  await app.register(helmet, { contentSecurityPolicy: false });
  app.decorate("shadowcheck", { env, redis, replayQueue });
  app.addHook("onRequest", async (request, reply) => { reply.header("X-Request-ID", request.id); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return sendError(reply, request.id, error);
    if (error instanceof ZodError) return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: error.issues.map((issue) => issue.message).join(" "), requestId: request.id } });
    request.log.error({ err: error, requestId: request.id }, "Unhandled API error");
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred.", requestId: request.id } });
  });
  app.addHook("onClose", async () => { await replayQueue.close(); await redis.quit(); });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try { await prisma.$queryRaw`SELECT 1`; await redis.ping(); return { status: "ready" }; }
    catch { return reply.status(503).send({ status: "unready" }); }
  });

  app.get("/api/v1/projects", async () => {
    const projects = await prisma.project.findMany({ orderBy: { updatedAt: "desc" }, include: { environments: true, regressionPolicy: true, _count: { select: { trafficRequests: true, replayRuns: true } } } });
    return { data: projects.map(projectView) };
  });
  app.post("/api/v1/projects", async (request, reply) => {
    const input = createProjectSchema.parse(request.body);
    for (const environment of input.environments) { normaliseBaseUrl(environment.baseUrl); await assertSafeTarget(normaliseBaseUrl(environment.baseUrl), env.ALLOW_PRIVATE_NETWORK_TARGETS); }
    const project = await prisma.project.create({ data: {
      name: input.name, description: input.description, maxConcurrency: input.maxConcurrency, requestsPerSecond: input.requestsPerSecond, allowWriteMethods: input.allowWriteMethods,
      environments: { create: input.environments.map((environment) => { const split = credentialsFromHeaders(environment.headers); return { type: environment.type, baseUrl: normaliseBaseUrl(environment.baseUrl).toString(), headers: asJson(split.safeHeaders), timeoutMs: environment.timeoutMs, enabled: environment.enabled, credentials: { create: split.secrets.map((secret) => ({ headerName: secret.headerName, encryptedValue: encryptSecret(secret.value, env.ENCRYPTION_KEY) })) } }; }) },
      regressionPolicy: { create: input.policy ?? regressionPolicySchema.parse({}) }
    }, include: { environments: { include: { credentials: true } }, regressionPolicy: true } });
    return reply.status(201).send({ data: projectView(project) });
  });
  app.get("/api/v1/projects/:projectId", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = await prisma.project.findUnique({ where: { id: projectId }, include: { environments: { include: { credentials: true } }, regressionPolicy: true, _count: { select: { trafficRequests: true, replayRuns: true } } } });
    if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found.");
    return { data: projectView(project) };
  });
  app.patch("/api/v1/projects/:projectId", async (request) => {
    const { projectId } = request.params as { projectId: string }; const input = updateProjectSchema.parse(request.body);
    const existing = await prisma.project.findUnique({ where: { id: projectId } }); if (!existing) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found.");
    if (input.environments) for (const environment of input.environments) { normaliseBaseUrl(environment.baseUrl); await assertSafeTarget(normaliseBaseUrl(environment.baseUrl), env.ALLOW_PRIVATE_NETWORK_TARGETS); }
    await prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { name: input.name, description: input.description, maxConcurrency: input.maxConcurrency, requestsPerSecond: input.requestsPerSecond, allowWriteMethods: input.allowWriteMethods, ...(input.policy ? { regressionPolicy: { upsert: { create: input.policy, update: input.policy } } } : {}) } });
      for (const environment of input.environments ?? []) {
        const split = credentialsFromHeaders(environment.headers);
        const saved = await tx.environment.upsert({
          where: { projectId_type: { projectId, type: environment.type } },
          create: { projectId, type: environment.type, baseUrl: normaliseBaseUrl(environment.baseUrl).toString(), headers: asJson(split.safeHeaders), timeoutMs: environment.timeoutMs, enabled: environment.enabled, credentials: { create: split.secrets.map((secret) => ({ headerName: secret.headerName, encryptedValue: encryptSecret(secret.value, env.ENCRYPTION_KEY) })) } },
          update: { baseUrl: normaliseBaseUrl(environment.baseUrl).toString(), headers: asJson(split.safeHeaders), timeoutMs: environment.timeoutMs, enabled: environment.enabled }
        });
        for (const secret of split.secrets) await tx.apiCredential.upsert({ where: { environmentId_headerName: { environmentId: saved.id, headerName: secret.headerName } }, create: { environmentId: saved.id, headerName: secret.headerName, encryptedValue: encryptSecret(secret.value, env.ENCRYPTION_KEY) }, update: { encryptedValue: encryptSecret(secret.value, env.ENCRYPTION_KEY) } });
      }
    });
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { environments: { include: { credentials: true } }, regressionPolicy: true } }); return { data: projectView(project) };
  });
  app.delete("/api/v1/projects/:projectId", async (request, reply) => { const { projectId } = request.params as { projectId: string }; const deleted = await prisma.project.deleteMany({ where: { id: projectId } }); if (!deleted.count) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found."); return reply.status(204).send(); });

  app.get("/api/v1/projects/:projectId/environments/:type/credentials", async (request) => { const { projectId, type } = request.params as { projectId: string; type: EnvironmentType }; const environment = await prisma.environment.findUnique({ where: { projectId_type: { projectId, type } }, include: { credentials: { select: { id: true, headerName: true, createdAt: true, updatedAt: true } } } }); if (!environment) throw new ApiError(404, "PROJECT_NOT_FOUND", "Environment was not found."); return { data: environment.credentials }; });
  app.post("/api/v1/projects/:projectId/environments/:type/credentials", async (request, reply) => { const { projectId, type } = request.params as { projectId: string; type: EnvironmentType }; const input = z.object({ headerName: z.string().min(1).max(200), value: z.string().min(1).max(10000) }).parse(request.body); const environment = await prisma.environment.findUnique({ where: { projectId_type: { projectId, type } } }); if (!environment) throw new ApiError(404, "PROJECT_NOT_FOUND", "Environment was not found."); const credential = await prisma.apiCredential.upsert({ where: { environmentId_headerName: { environmentId: environment.id, headerName: input.headerName } }, create: { environmentId: environment.id, headerName: input.headerName, encryptedValue: encryptSecret(input.value, env.ENCRYPTION_KEY) }, update: { encryptedValue: encryptSecret(input.value, env.ENCRYPTION_KEY) }, select: { id: true, headerName: true, createdAt: true, updatedAt: true } }); return reply.status(201).send({ data: credential }); });
  app.delete("/api/v1/credentials/:credentialId", async (request, reply) => { const { credentialId } = request.params as { credentialId: string }; const deleted = await prisma.apiCredential.deleteMany({ where: { id: credentialId } }); if (!deleted.count) throw new ApiError(404, "CREDENTIAL_NOT_FOUND", "Credential was not found."); return reply.status(204).send(); });

  app.post("/api/v1/projects/:projectId/traffic/import", async (request, reply) => {
    const { projectId } = request.params as { projectId: string }; const body = z.object({ format: z.enum(["shadowcheck", "har"]).default("shadowcheck"), traffic: z.unknown().optional(), har: z.unknown().optional() }).parse(request.body);
    const project = await prisma.project.findUnique({ where: { id: projectId }, include: { redactionRules: true } }); if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found.");
    let traffic: TrafficRequestInput[];
    try { traffic = body.format === "har" ? convertHar(body.har) : z.array(trafficRequestSchema).min(1).max(10000).parse(body.traffic); } catch (error) { throw new ApiError(400, "INVALID_TRAFFIC_FILE", error instanceof Error ? error.message : "Traffic format is invalid."); }
    const rules = project.redactionRules.map(ruleToInput); const sanitized = traffic.map((item) => sanitizeTrafficRequest(item, rules));
    await prisma.trafficRequest.createMany({ data: sanitized.map((item) => ({ projectId, name: item.name, method: item.method, path: item.path, headers: asJson(item.headers), body: item.body === undefined ? Prisma.JsonNull : asJson(item.body), query: item.query ? asJson(item.query) : Prisma.JsonNull })) });
    return reply.status(201).send({ data: { imported: sanitized.length } });
  });
  app.get("/api/v1/projects/:projectId/traffic", async (request) => { const { projectId } = request.params as { projectId: string }; const page = paginationSchema.parse(request.query); const result = await cursorPage((args) => prisma.trafficRequest.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, ...args }), page.cursor, page.limit); return result; });
  app.delete("/api/v1/traffic/:trafficId", async (request, reply) => { const { trafficId } = request.params as { trafficId: string }; const deleted = await prisma.trafficRequest.deleteMany({ where: { id: trafficId } }); if (!deleted.count) throw new ApiError(404, "TRAFFIC_NOT_FOUND", "Traffic request was not found."); return reply.status(204).send(); });

  app.get("/api/v1/projects/:projectId/redaction-rules", async (request) => ({ data: await prisma.redactionRule.findMany({ where: { projectId: (request.params as { projectId: string }).projectId }, orderBy: { createdAt: "asc" } }) }));
  app.post("/api/v1/projects/:projectId/redaction-rules", async (request, reply) => { const projectId = (request.params as { projectId: string }).projectId; const input = redactionRuleInputSchema.parse(request.body); const project = await prisma.project.findUnique({ where: { id: projectId } }); if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found."); const rule = await prisma.redactionRule.create({ data: { projectId, headerName: input.headerName, jsonPath: input.jsonPath, action: input.action } }); return reply.status(201).send({ data: rule }); });
  app.delete("/api/v1/redaction-rules/:ruleId", async (request, reply) => { const deleted = await prisma.redactionRule.deleteMany({ where: { id: (request.params as { ruleId: string }).ruleId } }); if (!deleted.count) throw new ApiError(404, "RULE_NOT_FOUND", "Redaction rule was not found."); return reply.status(204).send(); });
  app.get("/api/v1/projects/:projectId/ignore-rules", async (request) => ({ data: await prisma.ignoreRule.findMany({ where: { projectId: (request.params as { projectId: string }).projectId }, orderBy: { createdAt: "asc" } }) }));
  app.post("/api/v1/projects/:projectId/ignore-rules", async (request, reply) => { const projectId = (request.params as { projectId: string }).projectId; const input = ignoreRuleInputSchema.parse(request.body); const project = await prisma.project.findUnique({ where: { id: projectId } }); if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found."); const rule = await prisma.ignoreRule.create({ data: { projectId, ...input } }); return reply.status(201).send({ data: rule }); });
  app.delete("/api/v1/ignore-rules/:ruleId", async (request, reply) => { const deleted = await prisma.ignoreRule.deleteMany({ where: { id: (request.params as { ruleId: string }).ruleId } }); if (!deleted.count) throw new ApiError(404, "RULE_NOT_FOUND", "Ignore rule was not found."); return reply.status(204).send(); });

  app.post("/api/v1/projects/:projectId/openapi", async (request, reply) => { const projectId = (request.params as { projectId: string }).projectId; const input = z.object({ format: z.enum(["json", "yaml"]), document: z.unknown() }).parse(request.body); const project = await prisma.project.findUnique({ where: { id: projectId } }); if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found."); let document: Record<string, unknown>; try { document = parseOpenApi(input.document, input.format); } catch (error) { throw new ApiError(400, "INVALID_OPENAPI_DOCUMENT", error instanceof Error ? error.message : "OpenAPI document is invalid."); } const saved = await prisma.openApiDocument.upsert({ where: { projectId }, create: { projectId, format: input.format, document: asJson(document) }, update: { format: input.format, document: asJson(document) } }); return reply.status(201).send({ data: { id: saved.id, format: saved.format, updatedAt: saved.updatedAt } }); });
  app.get("/api/v1/projects/:projectId/openapi", async (request) => { const document = await prisma.openApiDocument.findUnique({ where: { projectId: (request.params as { projectId: string }).projectId }, select: { id: true, format: true, document: true, updatedAt: true } }); if (!document) throw new ApiError(404, "OPENAPI_NOT_FOUND", "No OpenAPI document is configured."); return { data: document }; });

  app.post("/api/v1/projects/:projectId/runs", async (request, reply) => {
    const { projectId } = request.params as { projectId: string }; const project = await prisma.project.findUnique({ where: { id: projectId }, include: { environments: true, trafficRequests: { select: { id: true, method: true } } } });
    if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found.");
    const baseline = project.environments.find((environment) => environment.type === "BASELINE"); const candidate = project.environments.find((environment) => environment.type === "CANDIDATE");
    if (!baseline?.enabled || !candidate?.enabled) throw new ApiError(400, "ENVIRONMENT_DISABLED", "Both environments must be enabled to replay traffic.");
    for (const environment of [baseline, candidate]) await assertSafeTarget(normaliseBaseUrl(environment.baseUrl), env.ALLOW_PRIVATE_NETWORK_TARGETS);
    const unsafe = project.trafficRequests.filter((item) => !["GET", "HEAD"].includes(item.method)); if (unsafe.length && !project.allowWriteMethods) throw new ApiError(400, "WRITE_REPLAY_DISABLED", `This dataset has ${unsafe.length} write request(s). Enable write-method replay in project settings first.`);
    if (!project.trafficRequests.length) throw new ApiError(400, "EMPTY_TRAFFIC", "Import at least one traffic request before starting a replay.");
    const run = await prisma.replayRun.create({ data: { projectId, status: "QUEUED", totalRequests: project.trafficRequests.length } });
    try { await replayQueue.addBulk(project.trafficRequests.map((trafficRequest) => ({ name: "replay-request", data: { runId: run.id, trafficRequestId: trafficRequest.id } satisfies ReplayJobData, opts: { jobId: `${run.id}:${trafficRequest.id}`, attempts: 1, removeOnComplete: true, removeOnFail: false } }))); }
    catch { await prisma.replayRun.update({ where: { id: run.id }, data: { status: "FAILED", completedAt: new Date() } }); throw new ApiError(503, "QUEUE_UNAVAILABLE", "Replay queue is unavailable."); }
    return reply.status(202).send({ data: run });
  });
  app.get("/api/v1/projects/:projectId/runs", async (request) => { const { projectId } = request.params as { projectId: string }; const page = paginationSchema.parse(request.query); return cursorPage((args) => prisma.replayRun.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, ...args }), page.cursor, page.limit); });
  app.get("/api/v1/runs/:runId", async (request) => { const run = await prisma.replayRun.findUnique({ where: { id: (request.params as { runId: string }).runId } }); if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "Replay run was not found."); return { data: run }; });
  app.post("/api/v1/runs/:runId/cancel", async (request) => { const runId = (request.params as { runId: string }).runId; const run = await prisma.replayRun.findUnique({ where: { id: runId } }); if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "Replay run was not found."); if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) throw new ApiError(409, "RUN_ALREADY_FINISHED", "This replay run has already finished."); await prisma.replayRun.update({ where: { id: runId }, data: { status: "CANCELLED", completedAt: new Date() } }); await redis.set(`shadowcheck:cancel:${runId}`, "1", "EX", 3600); const waiting = await replayQueue.getJobs(["waiting", "delayed"]); await Promise.all(waiting.filter((job) => job.data.runId === runId).map((job) => job.remove())); return { data: { id: runId, status: "CANCELLED" } }; });
  app.get("/api/v1/runs/:runId/results", async (request) => { const runId = (request.params as { runId: string }).runId; const query = z.object({ cursor: z.string().cuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(25), result: z.enum(["PASS", "WARNING", "REGRESSION", "ERROR"]).optional(), severity: z.enum(["INFO", "WARNING", "BREAKING"]).optional(), method: z.string().optional(), endpoint: z.string().optional(), differenceType: z.string().optional() }).parse(request.query); const where: any = { runId, ...(query.result ? { result: query.result } : {}), ...(query.method || query.endpoint ? { trafficRequest: { ...(query.method ? { method: query.method } : {}), ...(query.endpoint ? { path: { contains: query.endpoint, mode: "insensitive" } } : {}) } } : {}), ...(query.severity || query.differenceType ? { differences: { some: { ...(query.severity ? { severity: query.severity } : {}), ...(query.differenceType ? { type: query.differenceType } : {}) } } } : {}) }; const rows = await prisma.replayExecution.findMany({ where, include: { trafficRequest: { select: { method: true, path: true, name: true } }, differences: { select: { type: true, severity: true, path: true } } }, orderBy: { createdAt: "desc" }, take: query.limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) }); const nextCursor = rows.length > query.limit ? rows.pop()?.id ?? null : null; return { data: rows, nextCursor }; });
  app.get("/api/v1/executions/:executionId", async (request) => { const execution = await prisma.replayExecution.findUnique({ where: { id: (request.params as { executionId: string }).executionId }, include: { trafficRequest: true, differences: { orderBy: { path: "asc" } } } }); if (!execution) throw new ApiError(404, "EXECUTION_NOT_FOUND", "Replay execution was not found."); return { data: execution }; });
  return app;
}

declare module "fastify" { interface FastifyInstance { shadowcheck: { env: AppEnv; redis: ReturnType<typeof createRedis>; replayQueue: ReturnType<typeof createReplayQueue> } } }
