import type { FastifyInstance, FastifyReply } from "fastify";
import { prisma } from "./db.js";
import { authenticate, fail } from "./auth.js";
import { EventAudience, EventCategory, EventColor } from "../generated/prisma/enums.js";
import type { Prisma } from "../generated/prisma/client.js";

type EventBody = {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  notes?: string | null;
  audience: EventAudience;
  category: EventCategory;
  color: EventColor;
};
type Params = { id: string };

const dateTime = { type: "string", format: "date-time" } as const;
const properties = {
  title: { type: "string", minLength: 1 },
  startsAt: dateTime,
  endsAt: { type: ["string", "null"], format: "date-time" },
  allDay: { type: "boolean" },
  notes: { type: ["string", "null"] },
  audience: { enum: Object.values(EventAudience) },
  category: { enum: Object.values(EventCategory) },
  color: { enum: Object.values(EventColor) },
};
const params = { type: "object", properties: { id: { type: "string", format: "uuid" } } };

// Own events plus the couple's shared events. No couple = own events only.
const visible = (userId: string, coupleId: string | null): Prisma.EventWhereInput => ({
  OR: [{ createdById: userId }, ...(coupleId ? [{ coupleId, audience: EventAudience.couple }] : [])],
});

const notInCouple = (reply: FastifyReply) =>
  fail(reply, 409, "NOT_IN_COUPLE", "Você precisa estar em um casal para criar eventos do casal.");
const invalidRange = (reply: FastifyReply) =>
  fail(reply, 400, "INVALID_RANGE", "O fim do evento deve ser depois do início.");
const notFound = (reply: FastifyReply) => fail(reply, 404, "EVENT_NOT_FOUND", "Evento não encontrado.");

export async function eventRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  const currentUser = async (userId: string, reply: FastifyReply) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { coupleId: true } });
    if (!user) fail(reply, 401, "UNAUTHORIZED", "Sessão expirada. Entre novamente.");
    return user;
  };

  // shortcut: days are cut at Brasília midnight (-03:00, no DST), take a tz param if users span time zones.
  const dayStart = (date: string, plusDays = 0) =>
    new Date(new Date(`${date}T00:00:00-03:00`).getTime() + plusDays * 24 * 60 * 60 * 1000);

  // Days `from`..`to` inclusive. Overlap: starts before the end of `to`, ends (or starts, when no end) after `from`.
  app.get<{ Querystring: { from: string; to: string } }>(
    "/events",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["from", "to"],
          properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" } },
        },
      },
    },
    async (req, reply) => {
      const user = await currentUser(req.user.sub, reply);
      if (!user) return;
      const from = dayStart(req.query.from);
      return prisma.event.findMany({
        where: {
          AND: [
            visible(req.user.sub, user.coupleId),
            { startsAt: { lt: dayStart(req.query.to, 1) } },
            { OR: [{ endsAt: { gte: from } }, { endsAt: null, startsAt: { gte: from } }] },
          ],
        },
        orderBy: { startsAt: "asc" },
      });
    },
  );

  app.post<{ Body: EventBody }>(
    "/events",
    {
      schema: {
        body: {
          type: "object",
          required: ["title", "startsAt", "audience", "category", "color"],
          additionalProperties: false,
          properties,
        },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const user = await currentUser(userId, reply);
      if (!user) return;
      const body = req.body;
      if (body.audience === EventAudience.couple && !user.coupleId) return notInCouple(reply);
      if (body.endsAt && new Date(body.endsAt) < new Date(body.startsAt)) return invalidRange(reply);

      const event = await prisma.event.create({
        data: {
          ...body,
          createdById: userId,
          coupleId: body.audience === EventAudience.couple ? user.coupleId : null,
        },
      });
      return reply.code(201).send(event);
    },
  );

  app.patch<{ Params: Params; Body: Partial<EventBody> }>(
    "/events/:id",
    { schema: { params, body: { type: "object", minProperties: 1, additionalProperties: false, properties } } },
    async (req, reply) => {
      const user = await currentUser(req.user.sub, reply);
      if (!user) return;
      const event = await prisma.event.findFirst({
        where: { id: req.params.id, ...visible(req.user.sub, user.coupleId) },
      });
      if (!event) return notFound(reply);

      const body = req.body;
      if (body.audience === EventAudience.couple && !user.coupleId) return notInCouple(reply);
      const startsAt = body.startsAt ? new Date(body.startsAt) : event.startsAt;
      const endsAt = body.endsAt === undefined ? event.endsAt : body.endsAt && new Date(body.endsAt);
      if (endsAt && endsAt < startsAt) return invalidRange(reply);

      // coupleId only follows an explicit audience change, so editing an old couple's event doesn't share it with a new partner.
      const coupleId =
        body.audience === undefined ? {} : { coupleId: body.audience === EventAudience.couple ? user.coupleId : null };
      return prisma.event.update({ where: { id: event.id }, data: { ...body, ...coupleId } });
    },
  );

  app.delete<{ Params: Params }>("/events/:id", { schema: { params } }, async (req, reply) => {
    const user = await currentUser(req.user.sub, reply);
    if (!user) return;
    const { count } = await prisma.event.deleteMany({
      where: { id: req.params.id, ...visible(req.user.sub, user.coupleId) },
    });
    if (!count) return notFound(reply);
    return reply.code(204).send();
  });
}
