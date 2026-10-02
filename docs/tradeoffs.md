# Tradeoffs

| Decision | Chosen approach | Reason |
| --- | --- | --- |
| Replay execution | Redis and BullMQ jobs | Keeps HTTP routes fast and makes worker concurrency clear without operating Kafka. |
| Result storage | PostgreSQL rows plus JSONB | Filters and counters remain relational; headers, bodies, and compact values stay flexible. |
| Comparison | Deep JSON comparison plus structural traversal | Shows the actual change and catches contract shape changes without building a full schema compiler. |
| Progress | Dashboard polling | Reliable and easy to explain. SSE can be added if update volume needs it. |
| Arrays | Order sensitive | Predictable V1 behavior. Identity based matching would need endpoint knowledge. |
| OpenAPI | Optional, local references only | Adds useful candidate validation without making native replay dependent on a specification. |
| Target safety | Strict URL and resolved IP checks | Reduces SSRF exposure; local fixture replay explicitly opts into private targets. |
| Write requests | Explicit opt-in | Makes side effects visible and avoids automatic retries that could duplicate writes. |
