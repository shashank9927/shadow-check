import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import "dotenv/config";
import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  ENCRYPTION_KEY: z.string().min(1),
  REPLAY_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  DEFAULT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(5000),
  MAX_RESPONSE_BODY_BYTES: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(1048576),
  MAX_IMPORT_FILE_BYTES: z.coerce.number().int().min(1024).max(100 * 1024 * 1024).default(5242880),
  ALLOW_PRIVATE_NETWORK_TARGETS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  REPLAY_RESULT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
});
export type AppEnv = z.infer<typeof envSchema>;
export function readEnv(source: NodeJS.ProcessEnv = process.env): AppEnv { return envSchema.parse(source); }

export function encryptSecret(plainText: string, encodedKey: string): string {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be a base64 encoded 32-byte key.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}
export function decryptSecret(value: string, encodedKey: string): string {
  const [ivValue, tagValue, encrypted] = value.split(".");
  const key = Buffer.from(encodedKey, "base64");
  if (!ivValue || !tagValue || !encrypted || key.length !== 32) throw new Error("SECRET_DECRYPTION_FAILED");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "0.0.0.0" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 10 || first === 127 || first === 0 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function normaliseBaseUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS target URLs are allowed.");
  if (url.username || url.password) throw new Error("Target URLs cannot contain credentials.");
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}
export function joinTargetUrl(baseUrl: string, requestPath: string, query?: Record<string, string | number | boolean>): URL {
  if (!requestPath.startsWith("/") || requestPath.startsWith("//") || requestPath.includes("\\")) throw new Error("Request path must be an absolute path on the configured target.");
  const base = normaliseBaseUrl(baseUrl);
  const target = new URL(`${base.origin}${base.pathname}${requestPath}`.replace(/([^:]\/)\/+/g, "$1"));
  if (target.origin !== base.origin) throw new Error("Request path cannot change the target host.");
  for (const [key, value] of Object.entries(query ?? {})) target.searchParams.set(key, String(value));
  return target;
}
export async function assertSafeTarget(urlValue: URL, allowPrivateNetworkTargets: boolean): Promise<void> {
  const resolved = isIP(urlValue.hostname) ? urlValue.hostname : (await lookup(urlValue.hostname, { family: 0 })).address;
  if (!allowPrivateNetworkTargets && isPrivateAddress(resolved)) throw new Error("Target resolves to a private or link-local network address.");
}

export function endpointMatches(pattern: string | null | undefined, method: string, path: string): boolean {
  if (!pattern) return true;
  const expression = `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`;
  return new RegExp(expression, "i").test(`${method} ${path}`) || new RegExp(expression, "i").test(path);
}
