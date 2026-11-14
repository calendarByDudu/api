import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "./db.js";
import { authenticate, fail } from "./auth.js";

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const member = { select: { id: true, name: true, email: true } } as const;

class Conflict extends Error {}

export async function coupleRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  const findCouple = (id: string) => prisma.couple.findUnique({ where: { id }, include: { members: member } });

  app.get("/couple", async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    const couple = user?.coupleId && (await findCouple(user.coupleId));
    if (!couple) return fail(reply, 404, "NOT_IN_COUPLE", "Você ainda não está em um casal.");
    return couple;
  });

  app.post("/couple/invite", async (req, reply) => {
    const userId = req.user.sub;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return fail(reply, 401, "UNAUTHORIZED", "Sessão expirada. Entre novamente.");
    if (user.coupleId) return fail(reply, 409, "ALREADY_IN_COUPLE", "Você já está em um casal.");

    const current = await prisma.coupleInvite.findUnique({ where: { createdById: userId } });
    if (current && current.expiresAt > new Date()) return { code: current.code, expiresAt: current.expiresAt };

    await prisma.coupleInvite.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    for (let attempt = 0; ; attempt++) {
      const data = {
        code: randomInt(0, 1_000_000).toString().padStart(6, "0"),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      };
      try {
        const invite = await prisma.coupleInvite.upsert({
          where: { createdById: userId },
          create: { createdById: userId, ...data },
          update: data,
        });
        return reply.code(201).send({ code: invite.code, expiresAt: invite.expiresAt });
      } catch (e) {
        // P2002 = code collided with another user's active invite.
        if ((e as { code?: string }).code !== "P2002" || attempt >= 4) throw e;
      }
    }
  });

  app.post<{ Body: { code: string } }>(
    "/couple/join",
    {
      schema: {
        body: { type: "object", required: ["code"], properties: { code: { type: "string", pattern: "^[0-9]{6}$" } } },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const invite = await prisma.coupleInvite.findUnique({ where: { code: req.body.code } });
      if (!invite || invite.expiresAt < new Date())
        return fail(reply, 404, "INVALID_INVITE", "Convite inválido ou expirado.");
      if (invite.createdById === userId)
        return fail(reply, 400, "OWN_INVITE", "Você não pode usar o próprio convite.");

      try {
        const coupleId = await prisma.$transaction(async (tx) => {
          // Counts guard against concurrent joins: invite used once, both users still single.
          const used = await tx.coupleInvite.deleteMany({ where: { code: invite.code } });
          const couple = await tx.couple.create({ data: {} });
          const joined = await tx.user.updateMany({
            where: { id: { in: [userId, invite.createdById] }, coupleId: null },
            data: { coupleId: couple.id },
          });
          if (!used.count || joined.count !== 2) throw new Conflict();
          await tx.coupleInvite.deleteMany({ where: { createdById: userId } });
          return couple.id;
        });
        return reply.code(201).send(await findCouple(coupleId));
      } catch (e) {
        if (e instanceof Conflict)
          return fail(reply, 409, "ALREADY_IN_COUPLE", "Um de vocês já está em um casal ou o convite já foi usado.");
        throw e;
      }
    },
  );

  // Members and events get coupleId = null via onDelete: SetNull.
  app.delete("/couple", async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user?.coupleId) return fail(reply, 404, "NOT_IN_COUPLE", "Você ainda não está em um casal.");
    await prisma.couple.deleteMany({ where: { id: user.coupleId } });
    return reply.code(204).send();
  });
}
