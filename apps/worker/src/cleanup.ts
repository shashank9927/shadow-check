import { prisma, closeDatabase } from "@shadowcheck/database";
import { readEnv } from "@shadowcheck/shared";

const env = readEnv(); const cutoff = new Date(Date.now() - env.REPLAY_RESULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
const result = await prisma.replayRun.deleteMany({ where: { completedAt: { lt: cutoff } } });
console.log(`Deleted ${result.count} expired replay run(s).`); await closeDatabase();
