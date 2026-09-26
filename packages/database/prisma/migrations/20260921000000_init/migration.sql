-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";
CREATE TYPE "EnvironmentType" AS ENUM ('BASELINE', 'CANDIDATE');
CREATE TYPE "RedactionAction" AS ENUM ('REDACT', 'REMOVE');
CREATE TYPE "RunStatus" AS ENUM ('CREATED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "ExecutionResult" AS ENUM ('PASS', 'WARNING', 'REGRESSION', 'ERROR');
CREATE TYPE "DifferenceType" AS ENUM ('FIELD_ADDED', 'FIELD_REMOVED', 'VALUE_CHANGED', 'TYPE_CHANGED', 'ARRAY_LENGTH_CHANGED', 'STATUS_CHANGED', 'HEADER_CHANGED', 'LATENCY_REGRESSION', 'OPENAPI_VIOLATION');
CREATE TYPE "Severity" AS ENUM ('INFO', 'WARNING', 'BREAKING');

CREATE TABLE "Project" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT, "maxConcurrency" INTEGER NOT NULL DEFAULT 5, "requestsPerSecond" INTEGER, "allowWriteMethods" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Environment" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "type" "EnvironmentType" NOT NULL, "baseUrl" TEXT NOT NULL, "headers" JSONB NOT NULL DEFAULT '{}', "timeoutMs" INTEGER NOT NULL DEFAULT 5000, "enabled" BOOLEAN NOT NULL DEFAULT true, CONSTRAINT "Environment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ApiCredential" (
  "id" TEXT NOT NULL, "environmentId" TEXT NOT NULL, "headerName" TEXT NOT NULL, "encryptedValue" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TrafficRequest" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "name" TEXT, "method" TEXT NOT NULL, "path" TEXT NOT NULL, "headers" JSONB NOT NULL DEFAULT '{}', "body" JSONB, "query" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastUsedAt" TIMESTAMP(3), CONSTRAINT "TrafficRequest_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RedactionRule" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "headerName" TEXT, "jsonPath" TEXT, "action" "RedactionAction" NOT NULL DEFAULT 'REDACT', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "RedactionRule_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "IgnoreRule" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "jsonPath" TEXT NOT NULL, "endpointPattern" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "IgnoreRule_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RegressionPolicy" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "failOnStatusChange" BOOLEAN NOT NULL DEFAULT true, "failOnRemovedFields" BOOLEAN NOT NULL DEFAULT true, "failOnTypeChange" BOOLEAN NOT NULL DEFAULT true, "latencyWarningPercent" DOUBLE PRECISION NOT NULL DEFAULT 20, "latencyFailurePercent" DOUBLE PRECISION NOT NULL DEFAULT 50, "latencyMinimumMs" INTEGER NOT NULL DEFAULT 100, "selectedResponseHeaders" JSONB NOT NULL DEFAULT '[]', CONSTRAINT "RegressionPolicy_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ReplayRun" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "status" "RunStatus" NOT NULL DEFAULT 'CREATED', "totalRequests" INTEGER NOT NULL DEFAULT 0, "completedRequests" INTEGER NOT NULL DEFAULT 0, "passed" INTEGER NOT NULL DEFAULT 0, "warnings" INTEGER NOT NULL DEFAULT 0, "regressions" INTEGER NOT NULL DEFAULT 0, "errors" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), CONSTRAINT "ReplayRun_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ReplayExecution" (
  "id" TEXT NOT NULL, "runId" TEXT NOT NULL, "trafficRequestId" TEXT NOT NULL, "result" "ExecutionResult" NOT NULL, "baselineStatusCode" INTEGER, "candidateStatusCode" INTEGER, "baselineDurationMs" INTEGER, "candidateDurationMs" INTEGER, "baselineContentType" TEXT, "candidateContentType" TEXT, "baselineHeaders" JSONB NOT NULL DEFAULT '{}', "candidateHeaders" JSONB NOT NULL DEFAULT '{}', "baselineBody" JSONB, "candidateBody" JSONB, "baselineRawBody" TEXT, "candidateRawBody" TEXT, "baselineTruncated" BOOLEAN NOT NULL DEFAULT false, "candidateTruncated" BOOLEAN NOT NULL DEFAULT false, "errorCode" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3), CONSTRAINT "ReplayExecution_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ComparisonDifference" (
  "id" TEXT NOT NULL, "executionId" TEXT NOT NULL, "path" TEXT NOT NULL, "type" "DifferenceType" NOT NULL, "severity" "Severity" NOT NULL, "baselineValue" JSONB, "candidateValue" JSONB, "message" TEXT NOT NULL, CONSTRAINT "ComparisonDifference_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "OpenApiDocument" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "format" TEXT NOT NULL, "document" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "OpenApiDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Environment_projectId_type_key" ON "Environment"("projectId", "type");
CREATE UNIQUE INDEX "ApiCredential_environmentId_headerName_key" ON "ApiCredential"("environmentId", "headerName");
CREATE INDEX "TrafficRequest_projectId_createdAt_idx" ON "TrafficRequest"("projectId", "createdAt");
CREATE INDEX "TrafficRequest_projectId_method_path_idx" ON "TrafficRequest"("projectId", "method", "path");
CREATE INDEX "RedactionRule_projectId_idx" ON "RedactionRule"("projectId");
CREATE INDEX "IgnoreRule_projectId_idx" ON "IgnoreRule"("projectId");
CREATE UNIQUE INDEX "RegressionPolicy_projectId_key" ON "RegressionPolicy"("projectId");
CREATE INDEX "ReplayRun_projectId_createdAt_idx" ON "ReplayRun"("projectId", "createdAt");
CREATE INDEX "ReplayExecution_runId_result_idx" ON "ReplayExecution"("runId", "result");
CREATE UNIQUE INDEX "ReplayExecution_runId_trafficRequestId_key" ON "ReplayExecution"("runId", "trafficRequestId");
CREATE INDEX "ComparisonDifference_executionId_severity_idx" ON "ComparisonDifference"("executionId", "severity");
CREATE INDEX "ComparisonDifference_type_idx" ON "ComparisonDifference"("type");
CREATE UNIQUE INDEX "OpenApiDocument_projectId_key" ON "OpenApiDocument"("projectId");

ALTER TABLE "Environment" ADD CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrafficRequest" ADD CONSTRAINT "TrafficRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RedactionRule" ADD CONSTRAINT "RedactionRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IgnoreRule" ADD CONSTRAINT "IgnoreRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegressionPolicy" ADD CONSTRAINT "RegressionPolicy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplayRun" ADD CONSTRAINT "ReplayRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplayExecution" ADD CONSTRAINT "ReplayExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReplayRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplayExecution" ADD CONSTRAINT "ReplayExecution_trafficRequestId_fkey" FOREIGN KEY ("trafficRequestId") REFERENCES "TrafficRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComparisonDifference" ADD CONSTRAINT "ComparisonDifference_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ReplayExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpenApiDocument" ADD CONSTRAINT "OpenApiDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
