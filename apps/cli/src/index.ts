#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = (process.env.SHADOWCHECK_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const [command, ...args] = process.argv.slice(2);
function option(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function required(name: string): string { const value = option(name); if (!value) throw new Error(`Missing ${name}.`); return value; }
async function call(path: string, init?: RequestInit): Promise<any> { const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } }); const data = response.status === 204 ? null : await response.json(); if (!response.ok) throw new Error(data?.error?.message ?? `Request failed with ${response.status}.`); return data; }
async function projectId(value: string): Promise<string> { const projects = await call("/api/v1/projects"); const match = projects.data.find((project: any) => project.id === value || project.name.toLowerCase() === value.toLowerCase()); if (!match) throw new Error(`Project '${value}' was not found.`); return match.id; }
async function waitFor(runId: string): Promise<any> { for (;;) { const run = (await call(`/api/v1/runs/${runId}`)).data; process.stdout.write(`\rReplay ${run.id}: ${run.completedRequests}/${run.totalRequests} complete`); if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) { process.stdout.write("\n"); return run; } await new Promise((resolve) => setTimeout(resolve, 800)); } }

try {
  if (command === "run") {
    const id = await projectId(required("--project")); const started = (await call(`/api/v1/projects/${id}/runs`, { method: "POST" })).data;
    console.log(`Replay started: ${started.id}`); const run = args.includes("--wait") ? await waitFor(started.id) : started;
    if (args.includes("--wait")) { console.log(`Passed: ${run.passed}\nWarnings: ${run.warnings}\nBreaking: ${run.regressions}\nErrors: ${run.errors}\nResult: ${run.regressions || run.errors || run.status !== "COMPLETED" ? "FAILED" : "PASSED"}`); if (run.regressions || run.errors || run.status !== "COMPLETED") process.exitCode = 1; }
  } else if (command === "status") {
    const run = (await call(`/api/v1/runs/${required("--run")}`)).data; console.log(JSON.stringify(run, null, 2)); if (run.regressions || run.errors || ["FAILED", "CANCELLED"].includes(run.status)) process.exitCode = 1;
  } else if (command === "import") {
    const id = await projectId(required("--project")); const file = required("--file"); const content = JSON.parse(await readFile(resolve(file), "utf8")); const format = file.toLowerCase().endsWith(".har") ? "har" : "shadowcheck"; const result = await call(`/api/v1/projects/${id}/traffic/import`, { method: "POST", body: JSON.stringify(format === "har" ? { format, har: content } : { format, traffic: content }) }); console.log(`Imported ${result.data.imported} traffic request(s).`);
  } else if (command === "report") {
    const runId = args[0]; if (!runId) throw new Error("Provide a replay run ID."); const run = (await call(`/api/v1/runs/${runId}`)).data; const results = await call(`/api/v1/runs/${runId}/results?limit=100`); if (option("--format") === "json") console.log(JSON.stringify({ run, results: results.data }, null, 2)); else console.log(`Run ${run.id}: ${run.status}\n${run.passed} passed, ${run.warnings} warnings, ${run.regressions} regressions, ${run.errors} errors`); if (run.regressions || run.errors || ["FAILED", "CANCELLED"].includes(run.status)) process.exitCode = 1;
  } else {
    console.log("ShadowCheck\n\nCommands:\n  shadowcheck import --project <id-or-name> --file traffic.json\n  shadowcheck run --project <id-or-name> [--wait]\n  shadowcheck status --run <run-id>\n  shadowcheck report <run-id> [--format json]");
    if (command) process.exitCode = 1;
  }
} catch (error) { console.error(error instanceof Error ? error.message : "Unexpected CLI error."); process.exitCode = 1; }
