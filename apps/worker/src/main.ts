import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { prisma, closeDatabase } from "@shadowcheck/database";
import type { ComparisonOptions, ErrorCode, HttpCapture, RedactionRuleInput } from "@shadowcheck/contracts";
import { compareCaptures, validateOpenApiResponse } from "@shadowcheck/comparison";
import { REDACTED_VALUE, redactHeaders, redactJson } from "@shadowcheck/redaction";
import { assertSafeTarget, decryptSecret, endpointMatches, joinTargetUrl, readEnv } from "@shadowcheck/shared";
import { REPLAY_REQUEST_QUEUE, type ReplayJobData } from "./queue.js";
import { persistReplayExecution } from "./persistence.js";

const env = readEnv();
const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
type Permit = () => void;
const projectActive = new Map<string, number>();
const projectNextRequestAt = new Map<string, number>();
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
async function acquireProject(projectId: string, max: number, rps: number | null): Promise<Permit> {
  while ((projectActive.get(projectId) ?? 0) >= max) await sleep(20);
  projectActive.set(projectId, (projectActive.get(projectId) ?? 0) + 1);
  if (rps) { const now = Date.now(); const readyAt = projectNextRequestAt.get(projectId) ?? now; if (readyAt > now) await sleep(readyAt - now); projectNextRequestAt.set(projectId, Math.max(now, readyAt) + Math.ceil(1000 / rps)); }
  return () => projectActive.set(projectId, Math.max(0, (projectActive.get(projectId) ?? 1) - 1));
}
function cleanResponseHeaders(headers: Headers, rules: RedactionRuleInput[]): Record<string, string> { return redactHeaders(Object.fromEntries(headers.entries()), rules.flatMap((rule) => rule.headerName ? [rule.headerName] : [])); }
function errorCode(error: unknown, timedOut: boolean, cancelled: boolean): ErrorCode {
  if (cancelled) return "CANCELLED"; if (timedOut) return "TIMEOUT"; const code = (error as { code?: string }).code;
  if (code === "ENOTFOUND") return "DNS_ERROR"; if (code === "ECONNREFUSED") return "CONNECTION_REFUSED"; if (code?.includes("TLS")) return "TLS_ERROR"; return "UNKNOWN_ERROR";
}
async function boundedText(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > env.MAX_RESPONSE_BODY_BYTES) { await reader.cancel(); return { text: "", truncated: true }; } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return { text: new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),), truncated: false };
}
async function captureOnce(url: URL, method: string, headers: Record<string, string>, body: unknown, timeoutMs: number, rules: RedactionRuleInput[], runId: string): Promise<HttpCapture> {
  const controller = new AbortController(); let timedOut = false; let cancelled = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const watcher = setInterval(() => { void redis.exists(`shadowcheck:cancel:${runId}`).then((exists) => { if (exists) { cancelled = true; controller.abort(); } }); }, 100);
  const start = performance.now();
  try {
    const outgoing = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== REDACTED_VALUE));
    const hasBody = body !== undefined && body !== null && !["GET", "HEAD"].includes(method);
    if (hasBody && typeof body !== "string" && !Object.keys(outgoing).some((name) => name.toLowerCase() === "content-type")) outgoing["content-type"] = "application/json";
    const response = await fetch(url, { method, headers: outgoing, ...(hasBody ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}), signal: controller.signal, redirect: "error" });
    const received = await boundedText(response); const contentType = response.headers.get("content-type"); let parsed: unknown | null = null;
    if (!received.truncated && received.text && contentType?.toLowerCase().includes("json")) { try { parsed = redactJson(JSON.parse(received.text), rules.filter((rule): rule is RedactionRuleInput & { jsonPath: string } => Boolean(rule.jsonPath))); } catch { return { statusCode: response.status, headers: cleanResponseHeaders(response.headers, rules), body: null, rawBody: null, durationMs: Math.round(performance.now() - start), contentType, truncated: false, errorCode: "INVALID_RESPONSE" }; } }
    return { statusCode: response.status, headers: cleanResponseHeaders(response.headers, rules), body: parsed, rawBody: parsed === null && !received.truncated ? received.text.slice(0, env.MAX_RESPONSE_BODY_BYTES) : null, durationMs: Math.round(performance.now() - start), contentType, truncated: received.truncated, errorCode: received.truncated ? "RESPONSE_TOO_LARGE" : null };
  } catch (error) { return { statusCode: null, headers: {}, body: null, rawBody: null, durationMs: Math.round(performance.now() - start), contentType: null, truncated: false, errorCode: errorCode(error, timedOut, cancelled) }; }
  finally { clearTimeout(timeout); clearInterval(watcher); }
}
async function capture(url: URL, method: string, headers: Record<string, string>, body: unknown, timeoutMs: number, rules: RedactionRuleInput[], runId: string): Promise<HttpCapture> {
  const safeMethod = method === "GET" || method === "HEAD";
  let result = await captureOnce(url, method, headers, body, timeoutMs, rules, runId);
  const retryable = () => result.errorCode === "CONNECTION_REFUSED" || result.errorCode === "UNKNOWN_ERROR" || (result.statusCode !== null && [502, 503, 504].includes(result.statusCode));
  if (safeMethod && retryable()) { await sleep(100); result = await captureOnce(url, method, headers, body, timeoutMs, rules, runId); }
  return result;
}
function policyFrom(project: any): ComparisonOptions { const policy = project.regressionPolicy; return { failOnStatusChange: policy.failOnStatusChange, failOnRemovedFields: policy.failOnRemovedFields, failOnTypeChange: policy.failOnTypeChange, latencyWarningPercent: policy.latencyWarningPercent, latencyFailurePercent: policy.latencyFailurePercent, latencyMinimumMs: policy.latencyMinimumMs, selectedResponseHeaders: policy.selectedResponseHeaders as string[] }; }
function recordInput(rules: any[]): RedactionRuleInput[] { return rules.map((rule) => ({ ...(rule.headerName ? { headerName: rule.headerName } : { jsonPath: rule.jsonPath }), action: rule.action })); }
async function headersForEnvironment(environment: any): Promise<Record<string, string>> { const credentials = await Promise.all(environment.credentials.map(async (credential: any) => [credential.headerName, decryptSecret(credential.encryptedValue, env.ENCRYPTION_KEY)] as const)); return { ...(environment.headers as Record<string, string>), ...Object.fromEntries(credentials) }; }
async function processJob(job: Job<ReplayJobData>): Promise<void> {
  const data = job.data;
  const [run, request] = await Promise.all([
    prisma.replayRun.findUnique({ where: { id: data.runId }, include: { project: { include: { environments: { include: { credentials: true } }, redactionRules: true, ignoreRules: true, regressionPolicy: true, openApiDocument: true } } } }),
    prisma.trafficRequest.findUnique({ where: { id: data.trafficRequestId } })
  ]);
  if (!run || !request || run.status === "CANCELLED" || run.status === "FAILED" || run.status === "COMPLETED") return;
  await prisma.replayRun.updateMany({ where: { id: run.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date() } });
  const freshRun = await prisma.replayRun.findUniqueOrThrow({ where: { id: run.id } }); if (freshRun.status === "CANCELLED") return;
  const release = await acquireProject(run.projectId, run.project.maxConcurrency, run.project.requestsPerSecond);
  try {
    const baselineEnvironment = run.project.environments.find((item) => item.type === "BASELINE"); const candidateEnvironment = run.project.environments.find((item) => item.type === "CANDIDATE");
    if (!baselineEnvironment || !candidateEnvironment) throw new Error("Both replay environments are required.");
    const rules = recordInput(run.project.redactionRules);
    const baselineUrl = joinTargetUrl(baselineEnvironment.baseUrl, request.path, request.query as any); const candidateUrl = joinTargetUrl(candidateEnvironment.baseUrl, request.path, request.query as any);
    await assertSafeTarget(baselineUrl, env.ALLOW_PRIVATE_NETWORK_TARGETS); await assertSafeTarget(candidateUrl, env.ALLOW_PRIVATE_NETWORK_TARGETS);
    const [baselineHeaders, candidateHeaders] = await Promise.all([headersForEnvironment(baselineEnvironment), headersForEnvironment(candidateEnvironment)]);
    const requestHeaders = request.headers as Record<string, string>;
    const baseline = await capture(baselineUrl, request.method, { ...requestHeaders, ...baselineHeaders }, request.body, baselineEnvironment.timeoutMs, rules, run.id);
    const candidate = await capture(candidateUrl, request.method, { ...requestHeaders, ...candidateHeaders }, request.body, candidateEnvironment.timeoutMs, rules, run.id);
    const ignorePaths = run.project.ignoreRules.filter((rule) => endpointMatches(rule.endpointPattern, request.method, request.path)).map((rule) => rule.jsonPath);
    const comparison = compareCaptures(baseline, candidate, { ...policyFrom(run.project), ignorePaths });
    const openApiProblems = validateOpenApiResponse(run.project.openApiDocument?.document, request.method, request.path, candidate.statusCode, candidate.body);
    if (openApiProblems.length && comparison.result !== "ERROR") { comparison.differences.push(...openApiProblems); comparison.result = "REGRESSION"; }
    await persistReplayExecution(data, comparison, baseline, candidate);
  } finally { release(); }
}

const worker = new Worker<ReplayJobData>(REPLAY_REQUEST_QUEUE, processJob, { connection: redis, concurrency: env.REPLAY_CONCURRENCY });
worker.on("failed", async (job, error) => { if (job) { await prisma.replayRun.updateMany({ where: { id: job.data.runId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", completedAt: new Date() } }); } console.error("Replay worker job failed", error.message); });
const shutdown = async () => { await worker.close(); await redis.quit(); await closeDatabase(); process.exit(0); };
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
