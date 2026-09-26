import { buildServer } from "./server.js";
import { readEnv } from "@shadowcheck/shared";
import { closeDatabase } from "@shadowcheck/database";

const env = readEnv();
const server = await buildServer({ env });
const shutdown = async () => { await server.close(); await closeDatabase(); process.exit(0); };
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
await server.listen({ port: env.API_PORT, host: "0.0.0.0" });
