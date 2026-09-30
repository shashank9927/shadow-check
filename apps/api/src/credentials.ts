import { BUILT_IN_SENSITIVE_HEADERS } from "@shadowcheck/redaction";

export type EnvironmentHeaderSplit = {
  safeHeaders: Record<string, string>;
  secrets: Array<{ headerName: string; value: string }>;
};

export function credentialsFromHeaders(headers: Record<string, string>): EnvironmentHeaderSplit {
  const safeHeaders: Record<string, string> = {};
  const secrets: Array<{ headerName: string; value: string }> = [];

  for (const [headerName, value] of Object.entries(headers)) {
    if (BUILT_IN_SENSITIVE_HEADERS.has(headerName.toLowerCase())) secrets.push({ headerName, value });
    else safeHeaders[headerName] = value;
  }

  return { safeHeaders, secrets };
}
