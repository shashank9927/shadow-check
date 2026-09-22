import { z } from "zod";

export const httpMethodSchema = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

export const headersSchema = z.record(z.string(), z.string());

export const trafficRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  method: httpMethodSchema,
  path: z.string().trim().min(1).max(2048),
  headers: headersSchema.optional().default({}),
  body: z.unknown().optional(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
});
export type TrafficRequestInput = z.infer<typeof trafficRequestSchema>;

export const redactionActionSchema = z.enum(["REDACT", "REMOVE"]);
export const redactionRuleInputSchema = z.object({
  headerName: z.string().trim().min(1).max(200).optional(),
  jsonPath: z.string().trim().regex(/^\$(?:[.[].*)?$/, "Use a JSON path beginning with $").max(500).optional(),
  action: redactionActionSchema.default("REDACT")
}).refine((value) => Boolean(value.headerName) !== Boolean(value.jsonPath), "Provide exactly one header name or JSON path.");
export type RedactionRuleInput = z.infer<typeof redactionRuleInputSchema>;

export const ignoreRuleInputSchema = z.object({
  jsonPath: z.string().trim().regex(/^\$(?:[.[].*)?$/, "Use a JSON path beginning with $").max(500),
  endpointPattern: z.string().trim().max(500).optional()
});
export type IgnoreRuleInput = z.infer<typeof ignoreRuleInputSchema>;

export const regressionPolicySchema = z.object({
  failOnStatusChange: z.boolean().default(true),
  failOnRemovedFields: z.boolean().default(true),
  failOnTypeChange: z.boolean().default(true),
  latencyWarningPercent: z.number().min(0).max(10000).default(20),
  latencyFailurePercent: z.number().min(0).max(10000).default(50),
  latencyMinimumMs: z.number().int().min(0).max(60000).default(100),
  selectedResponseHeaders: z.array(z.string().min(1).max(200)).max(30).default([])
});
export type RegressionPolicyInput = z.infer<typeof regressionPolicySchema>;

export const environmentInputSchema = z.object({
  type: z.enum(["BASELINE", "CANDIDATE"]),
  baseUrl: z.string().url().max(2048),
  timeoutMs: z.number().int().min(100).max(120000).default(5000),
  enabled: z.boolean().default(true),
  headers: headersSchema.optional().default({})
});
export type EnvironmentInput = z.infer<typeof environmentInputSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  maxConcurrency: z.number().int().min(1).max(25).default(5),
  requestsPerSecond: z.number().int().min(1).max(1000).nullable().optional(),
  allowWriteMethods: z.boolean().default(false),
  environments: z.array(environmentInputSchema).length(2).refine((items) => new Set(items.map((item) => item.type)).size === 2, "Provide one baseline and one candidate environment."),
  policy: regressionPolicySchema.optional()
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema.partial().omit({ environments: true }).extend({
  environments: z.array(environmentInputSchema).length(2).refine((items) => new Set(items.map((item) => item.type)).size === 2, "Provide one baseline and one candidate environment.").optional()
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export type ErrorCode =
  | "DNS_ERROR" | "CONNECTION_REFUSED" | "TIMEOUT" | "TLS_ERROR" | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE" | "CANCELLED" | "UNKNOWN_ERROR";

export type HttpCapture = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: unknown | null;
  rawBody?: string | null;
  durationMs: number;
  contentType: string | null;
  truncated: boolean;
  errorCode: ErrorCode | null;
};

export const differenceTypes = [
  "FIELD_ADDED", "FIELD_REMOVED", "VALUE_CHANGED", "TYPE_CHANGED", "ARRAY_LENGTH_CHANGED",
  "STATUS_CHANGED", "HEADER_CHANGED", "LATENCY_REGRESSION", "OPENAPI_VIOLATION"
] as const;
export type DifferenceType = (typeof differenceTypes)[number];
export type Severity = "INFO" | "WARNING" | "BREAKING";
export type ExecutionResult = "PASS" | "WARNING" | "REGRESSION" | "ERROR";

export type ComparisonDifference = {
  path: string;
  type: DifferenceType;
  severity: Severity;
  baseline: unknown;
  candidate: unknown;
  message: string;
};

export type ComparisonOptions = RegressionPolicyInput & { ignorePaths?: string[] };
export type ComparisonOutput = { result: ExecutionResult; differences: ComparisonDifference[]; errorCode: ErrorCode | null };

export const paginationSchema = z.object({
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const harSchema = z.object({
  log: z.object({
    entries: z.array(z.object({
      request: z.object({
        method: z.string(), url: z.string(),
        headers: z.array(z.object({ name: z.string(), value: z.string() })).optional().default([]),
        queryString: z.array(z.object({ name: z.string(), value: z.string() })).optional().default([]),
        postData: z.object({ text: z.string().optional() }).optional()
      })
    }))
  })
});
