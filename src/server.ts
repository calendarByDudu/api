import "dotenv/config";
import Fastify, { type FastifyError } from "fastify";
import jwt from "@fastify/jwt";
import { prisma } from "./db.js";
import { authRoutes } from "./auth.js";

const app = Fastify({ logger: true });

await app.register(jwt, { secret: process.env.JWT_SECRET!, sign: { expiresIn: "15m" } });

app.setErrorHandler<FastifyError>((err, _req, reply) => {
  if (err.validation || (err.statusCode ?? 500) < 500)
    return reply.code(err.statusCode ?? 400).send({ error: { code: "VALIDATION_ERROR", message: "Dados inválidos." } });
  app.log.error(err);
  return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Erro interno." } });
});

app.get("/health", async () => {
  await prisma.$queryRaw`SELECT 1`;
  return { ok: true };
});

await app.register(authRoutes);

app.addHook("onClose", () => prisma.$disconnect());

await app.listen({ port: Number(process.env.PORT ?? 3333), host: "0.0.0.0" });
