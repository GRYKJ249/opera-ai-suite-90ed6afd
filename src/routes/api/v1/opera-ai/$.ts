import { createFileRoute } from "@tanstack/react-router";

import { getRuntime } from "@/lib/opera/runtime.server";
import { hashPassword, signJwt, verifyJwt, verifyPassword, ROLES, type Role } from "@/lib/opera/auth";

type Ctx = { path: string[]; request: Request; url: URL };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function claimsFrom(request: Request) {
  const rt = getRuntime();
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
  if (!token) return null;
  return verifyJwt(rt.secret, token);
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

async function handle({ path, request, url }: Ctx): Promise<Response> {
  const rt = getRuntime();
  await rt.ready;
  const [group, ...rest] = path;
  const method = request.method.toUpperCase();

  /* ------------------------------- auth ------------------------------- */
  if (group === "auth") {
    const action = rest[0];
    if (action === "register" && method === "POST") {
      const input = await body<{ email?: string; password?: string; role?: Role }>(request);
      if (!input.email || !input.password) return json({ error: "email and password required" }, 400);
      const existing = await rt.db.find("users", { email: input.email });
      if (existing.length) return json({ error: "email already registered" }, 409);
      const role: Role = ROLES.includes(input.role as Role) ? (input.role as Role) : "USER";
      const user = await rt.db.insert("users", {
        email: input.email,
        role,
        passwordHash: await hashPassword(input.password),
        status: "active",
      });
      rt.log("info", "auth", `registered ${input.email} as ${role}`);
      return json({ id: user._id, email: user["email"], role });
    }
    if (action === "login" && method === "POST") {
      const input = await body<{ email?: string; password?: string }>(request);
      const [user] = await rt.db.find("users", { email: input.email ?? "" });
      if (!user || !(await verifyPassword(input.password ?? "", String(user["passwordHash"])))) {
        rt.log("warn", "auth", `failed login for ${input.email ?? "unknown"}`);
        return json({ error: "invalid credentials" }, 401);
      }
      const token = await signJwt(rt.secret, {
        sub: user._id,
        email: String(user["email"]),
        role: user["role"] as Role,
      });
      rt.log("info", "auth", `issued JWT for ${user["email"]}`);
      return json({ token, role: user["role"], email: user["email"], expiresIn: 3600 });
    }
    if (action === "me") {
      const claims = await claimsFrom(request);
      return claims ? json(claims) : json({ error: "unauthorized" }, 401);
    }
    if (action === "users") {
      const claims = await claimsFrom(request);
      if (!claims) return json({ error: "unauthorized" }, 401);
      if (claims.role !== "ADMIN") return json({ error: "forbidden: ADMIN role required" }, 403);
      const users = await rt.db.find("users", {});
      return json(
        users.map((u) => ({
          id: u._id,
          email: u["email"],
          role: u["role"],
          status: u["status"],
          quota: rt.cloud.quotaFor(u._id),
          used: rt.cloud.usageFor(u._id),
        })),
      );
    }
  }

  /* -------------------------------- db -------------------------------- */
  if (group === "db") {
    if (rest[0] === "collections" && method === "GET") return json(rt.db.stats());
    if (rest[0] === "wal" && method === "GET") return json(rt.db.wal.slice(-100).reverse());
    if (rest[0] === "checkpoint" && method === "POST") return json(await rt.db.checkpoint());
    if (rest[0] === "recover" && method === "POST") return json(await rt.db.recover());
    const collection = rest[0];
    const action = rest[1];
    if (collection && action) {
      const input = await body<{
        query?: Record<string, unknown>;
        update?: Record<string, Record<string, unknown>>;
        doc?: Record<string, unknown>;
        field?: string;
        limit?: number;
        sort?: string;
      }>(request);
      if (action === "find")
        return json(
          await rt.db.find(collection, input.query ?? {}, {
            ...(input.limit !== undefined && { limit: input.limit }),
            ...(input.sort !== undefined && { sort: input.sort }),
          }),
        );
      if (action === "insert") return json(await rt.db.insert(collection, input.doc ?? {}));
      if (action === "update")
        return json(await rt.db.update(collection, input.query ?? {}, input.update ?? {}));
      if (action === "delete") return json({ deleted: await rt.db.delete(collection, input.query ?? {}) });
      if (action === "index") return json(await rt.db.createIndex(collection, input.field ?? "_id"));
    }
  }

  /* ------------------------------ storage ------------------------------ */
  if (group === "storage") {
    const action = rest[0];
    if (action === "upload" && method === "POST") {
      const claims = await claimsFrom(request);
      if (!claims) return json({ error: "unauthorized" }, 401);
      const name = request.headers.get("x-file-name") ?? "upload.bin";
      try {
        const file = await rt.cloud.ingest(request.body, {
          name: decodeURIComponent(name),
          contentType: request.headers.get("content-type") ?? "application/octet-stream",
          owner: claims.sub,
        });
        return json(file, 201);
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        rt.log("error", "operacloud", (error as Error).message);
        return json({ error: (error as Error).message }, status);
      }
    }
    if (action === "files") {
      const claims = await claimsFrom(request);
      if (!claims) return json({ error: "unauthorized" }, 401);
      const files = [...rt.cloud.files.values()].filter(
        (f) => claims.role === "ADMIN" || f.owner === claims.sub,
      );
      return json(files);
    }
    if (action === "quota") {
      const claims = await claimsFrom(request);
      if (!claims) return json({ error: "unauthorized" }, 401);
      if (method === "POST" && claims.role === "ADMIN") {
        const input = await body<{ owner?: string; bytes?: number }>(request);
        return json(rt.cloud.setQuota(input.owner ?? claims.sub, Number(input.bytes ?? 0)));
      }
      return json({
        owner: claims.sub,
        quota: rt.cloud.quotaFor(claims.sub),
        used: rt.cloud.usageFor(claims.sub),
      });
    }
    if (action === "download" && rest[1]) {
      const claims = await claimsFrom(request);
      if (!claims) return json({ error: "unauthorized" }, 401);
      return rt.cloud.download(rest[1], request.headers.get("range"));
    }
    if (action === "signed" && rest[1]) {
      const ok = await rt.cloud.verifySignature(
        rest[1],
        url.searchParams.get("expires"),
        url.searchParams.get("signature"),
      );
      if (!ok) return json({ error: "invalid or expired signature" }, 403);
      return rt.cloud.download(rest[1], request.headers.get("range"));
    }
    if (action === "presign" && method === "POST") {
      const claims = await claimsFrom(request);
      if (!claims) return json({ error: "unauthorized" }, 401);
      const input = await body<{ fileId?: string; ttl?: number }>(request);
      if (!input.fileId || !rt.cloud.files.has(input.fileId)) return json({ error: "file not found" }, 404);
      return json(await rt.cloud.presign(input.fileId, input.ttl ?? 300));
    }
    if (action === "delete" && rest[1] && method === "POST") {
      const claims = await claimsFrom(request);
      if (!claims) return json({ error: "unauthorized" }, 401);
      return json({ deleted: rt.cloud.remove(rest[1]) });
    }
  }

  /* ------------------------------- system ------------------------------ */
  if (group === "system") {
    if (rest[0] === "logs") return json(rt.logs.slice(-150).reverse());
    if (rest[0] === "status")
      return json({
        service: "opera-ai",
        uptimeSeconds: Math.round((Date.now() - rt.startedAt) / 1000),
        db: rt.db.stats(),
        storage: rt.cloud.stats(),
        logLines: rt.logs.length,
      });
  }

  return json({ error: "unknown endpoint", path: `/${path.join("/")}` }, 404);
}

export const Route = createFileRoute("/api/v1/opera-ai/$")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        handle({ path: splat(params), request, url: new URL(request.url) }),
      POST: ({ request, params }) =>
        handle({ path: splat(params), request, url: new URL(request.url) }),
      DELETE: ({ request, params }) =>
        handle({ path: splat(params), request, url: new URL(request.url) }),
    },
  },
});

function splat(params: Record<string, string | undefined>): string[] {
  return (params["_splat"] ?? "").split("/").filter(Boolean);
}
