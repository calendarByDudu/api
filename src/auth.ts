import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply } from "fastify";
import { prisma } from "./db.js";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const email = { type: "string", format: "email" } as const;
const password = { type: "string", minLength: 4 } as const;
const code = { type: "string", pattern: "^[0-9]{6}$" } as const;
const body = (properties: Record<string, object>) => ({
  body: { type: "object", required: Object.keys(properties), properties },
});

async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${(await scryptAsync(pw, salt, 64)).toString("hex")}`;
}

async function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  return timingSafeEqual(await scryptAsync(pw, Buffer.from(salt, "hex"), 64), Buffer.from(hash, "hex"));
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const normalize = (e: string) => e.trim().toLowerCase();

const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

// shortcut: OTP only goes to the log, plug a real e-mail provider before production.
function sendOtpEmail(app: FastifyInstance, to: string, otp: string) {
  app.log.info({ to, otp }, "password reset OTP");
}

export async function authRoutes(app: FastifyInstance) {
  const publicUser = (user: { id: string; name: string; email: string }) => ({
    id: user.id,
    name: user.name,
    email: user.email,
  });

  async function session(user: { id: string; name: string; email: string }) {
    const refreshToken = randomBytes(32).toString("base64url");
    await prisma.refreshToken.create({
      data: {
        tokenHash: sha256(refreshToken).toString("hex"),
        userId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return { accessToken: app.jwt.sign({ sub: user.id }), refreshToken };
  }

  // Returns userId when the code is valid, otherwise sends the 401 and returns null.
  async function consumeAttempt(reply: FastifyReply, mail: string, otp: string) {
    const user = await prisma.user.findUnique({ where: { email: normalize(mail) }, include: { passwordReset: true } });
    const reset = user?.passwordReset;
    if (!reset || reset.attempts >= OTP_MAX_ATTEMPTS) {
      fail(reply, 401, "INVALID_OTP", "Código inválido.");
      return null;
    }
    if (reset.expiresAt < new Date()) {
      await prisma.passwordResetOtp.delete({ where: { userId: reset.userId } });
      fail(reply, 401, "OTP_EXPIRED", "Código expirado. Peça um novo.");
      return null;
    }
    if (!timingSafeEqual(sha256(otp), Buffer.from(reset.codeHash, "hex"))) {
      await prisma.passwordResetOtp.update({ where: { userId: reset.userId }, data: { attempts: { increment: 1 } } });
      fail(reply, 401, "INVALID_OTP", "Código inválido.");
      return null;
    }
    return reset.userId;
  }

  app.post<{ Body: { name: string; email: string; password: string } }>(
    "/auth/signup",
    { schema: body({ name: { type: "string", minLength: 1 }, email, password }) },
    async (req, reply) => {
      try {
        const user = await prisma.user.create({
          data: {
            name: req.body.name.trim(),
            email: normalize(req.body.email),
            passwordHash: await hashPassword(req.body.password),
          },
        });
        return reply.code(201).send(await session(user));
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") return fail(reply, 409, "CONFLICT", "E-mail já cadastrado.");
        throw e;
      }
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    "/auth/login",
    { schema: body({ email, password: { type: "string", minLength: 1 } }) },
    async (req, reply) => {
      const user = await prisma.user.findUnique({ where: { email: normalize(req.body.email) } });
      if (!user || !(await checkPassword(req.body.password, user.passwordHash)))
        return fail(reply, 401, "INVALID_CREDENTIALS", "E-mail ou senha inválidos.");
      return session(user);
    },
  );

  app.post<{ Body: { refreshToken: string } }>(
    "/auth/refresh",
    { schema: body({ refreshToken: { type: "string", minLength: 1 } }) },
    async (req, reply) => {
      const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: sha256(req.body.refreshToken).toString("hex") },
        include: { user: true },
      });
      // Rotation: deleteMany count guards against two concurrent refreshes with the same token.
      const { count } = stored ? await prisma.refreshToken.deleteMany({ where: { id: stored.id } }) : { count: 0 };
      if (!stored || !count || stored.expiresAt < new Date())
        return fail(reply, 401, "UNAUTHORIZED", "Sessão expirada. Entre novamente.");
      return session(stored.user);
    },
  );

  app.get("/auth/me", async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return fail(reply, 401, "UNAUTHORIZED", "Sessão expirada. Entre novamente.");
    }
    const user = await prisma.user.findUnique({ where: { id: (req.user as { sub: string }).sub } });
    if (!user) return fail(reply, 401, "UNAUTHORIZED", "Sessão expirada. Entre novamente.");
    return publicUser(user);
  });

  app.post<{ Body: { email: string } }>("/auth/password/forgot", { schema: body({ email }) }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { email: normalize(req.body.email) } });
    if (user) {
      const otp = randomInt(0, 1_000_000).toString().padStart(6, "0");
      const data = { codeHash: sha256(otp).toString("hex"), attempts: 0, expiresAt: new Date(Date.now() + OTP_TTL_MS) };
      await prisma.passwordResetOtp.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
      sendOtpEmail(app, user.email, otp);
    }
    return reply.code(204).send();
  });

  app.post<{ Body: { email: string; code: string } }>(
    "/auth/password/verify-otp",
    { schema: body({ email, code }) },
    async (req, reply) => {
      if (await consumeAttempt(reply, req.body.email, req.body.code)) return reply.code(204).send();
    },
  );

  app.post<{ Body: { email: string; code: string; password: string } }>(
    "/auth/password/reset",
    { schema: body({ email, code, password }) },
    async (req, reply) => {
      const userId = await consumeAttempt(reply, req.body.email, req.body.code);
      if (!userId) return;
      await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(req.body.password) } }),
        prisma.passwordResetOtp.delete({ where: { userId } }),
        prisma.refreshToken.deleteMany({ where: { userId } }),
      ]);
      return reply.code(204).send();
    },
  );
}
