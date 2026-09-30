import { Prisma, prisma } from "@shadowcheck/database";
import type { ComparisonOutput, HttpCapture } from "@shadowcheck/contracts";
import type { ReplayJobData } from "./queue.js";

function asJson(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }

export async function persistReplayExecution(job: ReplayJobData, result: ComparisonOutput, baseline: HttpCapture, candidate: HttpCapture): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.replayExecution.findUnique({ where: { runId_trafficRequestId: { runId: job.runId, trafficRequestId: job.trafficRequestId } } });
    if (existing) return;
    const execution = await tx.replayExecution.create({ data: {
      runId: job.runId, trafficRequestId: job.trafficRequestId, result: result.result, baselineStatusCode: baseline.statusCode, candidateStatusCode: candidate.statusCode, baselineDurationMs: baseline.durationMs, candidateDurationMs: candidate.durationMs, baselineContentType: baseline.contentType, candidateContentType: candidate.contentType, baselineHeaders: asJson(baseline.headers), candidateHeaders: asJson(candidate.headers), baselineBody: baseline.body === null ? Prisma.JsonNull : asJson(baseline.body), candidateBody: candidate.body === null ? Prisma.JsonNull : asJson(candidate.body), baselineRawBody: baseline.rawBody ?? null, candidateRawBody: candidate.rawBody ?? null, baselineTruncated: baseline.truncated, candidateTruncated: candidate.truncated, errorCode: result.errorCode, completedAt: new Date(), differences: { create: result.differences.map((difference) => ({ path: difference.path, type: difference.type, severity: difference.severity, baselineValue: difference.baseline === null || difference.baseline === undefined ? Prisma.JsonNull : asJson(difference.baseline), candidateValue: difference.candidate === null || difference.candidate === undefined ? Prisma.JsonNull : asJson(difference.candidate), message: difference.message })) }
    } });
    await tx.trafficRequest.update({ where: { id: job.trafficRequestId }, data: { lastUsedAt: new Date() } });
    await tx.replayRun.update({ where: { id: job.runId }, data: { completedRequests: { increment: 1 }, ...(execution.result === "PASS" ? { passed: { increment: 1 } } : {}), ...(execution.result === "WARNING" ? { warnings: { increment: 1 } } : {}), ...(execution.result === "REGRESSION" ? { regressions: { increment: 1 } } : {}), ...(execution.result === "ERROR" ? { errors: { increment: 1 } } : {}) } });
    await tx.$executeRaw`UPDATE "ReplayRun" SET status = 'COMPLETED', "completedAt" = NOW() WHERE id = ${job.runId} AND status = 'RUNNING' AND "completedRequests" >= "totalRequests"`;
  });
}
