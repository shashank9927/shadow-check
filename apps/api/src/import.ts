import { harSchema, trafficRequestSchema } from "@shadowcheck/contracts";
import type { TrafficRequestInput } from "@shadowcheck/contracts";

export function convertHar(value: unknown): TrafficRequestInput[] {
  const har = harSchema.parse(value);

  return har.log.entries.map(({ request }) => {
    const url = new URL(request.url);
    let body: unknown;
    if (request.postData?.text) {
      try { body = JSON.parse(request.postData.text); }
      catch { body = request.postData.text; }
    }

    return trafficRequestSchema.parse({
      name: `${request.method.toUpperCase()} ${url.pathname}`,
      method: request.method.toUpperCase(),
      path: url.pathname,
      headers: Object.fromEntries(request.headers.map((header) => [header.name, header.value])),
      query: Object.fromEntries(request.queryString.map((part) => [part.name, part.value])),
      ...(body !== undefined ? { body } : {})
    });
  });
}
