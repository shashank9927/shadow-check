# Security model

ShadowCheck handles recorded HTTP data, so its first safety boundary is import. Headers named Authorization, Proxy-Authorization, Cookie, Set-Cookie, and X-API-Key are replaced with `[REDACTED]` before a `TrafficRequest` is saved. Project rules can mask or remove JSON paths such as `$.password` and `$.payment.cardNumber`. Tests assert that the sanitization function returns no raw values.

Environment credentials serve a different purpose: they let workers authenticate against a controlled target. Values are AES-256-GCM encrypted with the deployment `ENCRYPTION_KEY`; responses expose only credential header names. Keep the key in a secret manager for any shared deployment and rotate credentials if the key is exposed.

Replay targets are untrusted configuration. The worker permits only HTTP and HTTPS, does not follow redirects, rejects embedded URL credentials and scheme relative paths, anchors paths to the configured origin, resolves hostnames, and blocks private, loopback, and link local destinations unless `ALLOW_PRIVATE_NETWORK_TARGETS=true`. The setting is required for local Docker fixtures and should be false in shared environments.

POST, PUT, PATCH, and DELETE are disabled by default and receive no automatic retry. Even enabled writes are not exactly once: a process failure after an external API call and before the local database transaction could repeat work. Use disposable data, idempotency keys at the target API, or GET/HEAD only for sensitive systems.

Worker logs include run, execution, method, path, and duration context but must never include secret headers, API key values, cookies, or unredacted bodies. Body reads have a hard size cap to control storage and memory use. This V1 assumes a trusted internal network and has no user authentication or authorization.
