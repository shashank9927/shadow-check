import { Queue } from "bullmq";
import IORedis from "ioredis";

export const REPLAY_REQUEST_QUEUE = "shadowcheck-replay-request";
export type ReplayJobData = { runId: string; trafficRequestId: string };
export function createRedis(url: string): IORedis { return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true }); }
export function createReplayQueue(connection: IORedis): Queue<ReplayJobData> { return new Queue<ReplayJobData>(REPLAY_REQUEST_QUEUE, { connection }); }
