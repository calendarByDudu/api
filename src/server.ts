import "dotenv/config";
import Fastify from "fastify";
import { prisma } from "./db.js";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  await prisma.$queryRaw`SELECT 1`;
  return { ok: true };
});

app.addHook("onClose", () => prisma.$disconnect());

await app.listen({ port: Number(process.env.PORT ?? 3333), host: "0.0.0.0" });
