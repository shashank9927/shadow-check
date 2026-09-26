import type { FastifyReply } from "fastify";

export class ApiError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) { super(message); }
}
export function sendError(reply: FastifyReply, requestId: string, error: ApiError): FastifyReply {
  return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, requestId } });
}
