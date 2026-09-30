import Fastify from "fastify";

const variant = process.env.FIXTURE_VARIANT === "candidate" ? "candidate" : "baseline";
const port = Number(process.env.PORT ?? (variant === "candidate" ? 3002 : 3001));
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const app = Fastify({ logger: true });
app.get("/health", async () => ({ status: "ok", service: "commerce" }));
app.get("/users/1", async () => variant === "baseline" ? { id: 1, name: "Anna", plan: "PRO" } : { id: 1, name: "Anna" });
app.get("/products", async () => variant === "baseline" ? { products: [{ id: "p1", name: "Keyboard", price: 49.99 }] } : { products: [{ id: "p1", name: "Keyboard", price: "49.99" }] });
app.get("/orders/failure", async (_request, reply) => variant === "candidate" ? reply.status(500).send({ error: "intentional candidate failure" }) : { id: "o-1", state: "PAID" });
app.get("/slow", async () => { await wait(variant === "candidate" ? 140 : 110); return { status: "ok" }; });
app.get("/timestamp", async () => ({ id: 7, requestId: `${variant}-${Math.random().toString(16).slice(2)}`, timestamp: new Date().toISOString() }));
app.get("/catalog", async () => variant === "candidate" ? { id: "p1", name: "Keyboard", category: "accessories" } : { id: "p1", name: "Keyboard" });
app.post("/orders", async (request, reply) => reply.status(201).send({ id: "safe-demo-order", acceptedEmail: (request.body as { email?: string } | null)?.email ?? null, quantity: (request.body as { quantity?: number } | null)?.quantity ?? 1 }));
const close = async () => { await app.close(); process.exit(0); };
process.once("SIGINT", close); process.once("SIGTERM", close);
await app.listen({ port, host: "0.0.0.0" });
