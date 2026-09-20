// Shared Opera AI runtime singleton: database, storage engine, auth registry
// and the live system log ring buffer.

import { OperaDB } from "./db";
import { OperaCloud } from "./storage";
import { hashPassword, type Role } from "./auth";

export type LogLine = { ts: string; level: string; scope: string; message: string; meta?: unknown };

export type OperaRuntime = {
  db: OperaDB;
  cloud: OperaCloud;
  logs: LogLine[];
  secret: string;
  startedAt: number;
  log: (level: string, scope: string, message: string, meta?: unknown) => void;
  ready: Promise<void>;
};

const KEY = "__opera_ai_runtime__";
const LOG_LIMIT = 300;

export function getRuntime(): OperaRuntime {
  const store = globalThis as unknown as Record<string, OperaRuntime | undefined>;
  const existing = store[KEY];
  if (existing) return existing;

  const secret = process.env["OPERA_JWT_SECRET"] ?? "opera-ai-dev-secret-key-change-me";
  const logs: LogLine[] = [];
  const log = (level: string, scope: string, message: string, meta?: unknown) => {
    logs.push({ ts: new Date().toISOString(), level, scope, message, ...(meta !== undefined && { meta }) });
    if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
  };

  const db = new OperaDB((level, message, meta) => log(level, "operadb", message, meta));
  const cloud = new OperaCloud(secret, (level, message, meta) => log(level, "operacloud", message, meta));

  const runtime: OperaRuntime = {
    db,
    cloud,
    logs,
    secret,
    startedAt: Date.now(),
    log,
    ready: Promise.resolve(),
  };
  runtime.ready = seed(runtime);
  store[KEY] = runtime;
  return runtime;
}

async function seed(rt: OperaRuntime) {
  rt.log("info", "system", "Opera AI runtime booting");
  await rt.db.createIndex("users", "email");
  await rt.db.createIndex("users", "role");
  const accounts: Array<{ email: string; password: string; role: Role }> = [
    { email: "admin@opera.ai", password: "opera-admin", role: "ADMIN" },
    { email: "user@opera.ai", password: "opera-user", role: "USER" },
    { email: "bot@opera.ai", password: "opera-bot", role: "SERVICE_BOT" },
  ];
  for (const account of accounts) {
    await rt.db.insert("users", {
      email: account.email,
      role: account.role,
      passwordHash: await hashPassword(account.password),
      status: "active",
    });
  }
  for (const doc of [
    { name: "aria-tts", kind: "voice", latencyMs: 120, active: true },
    { name: "maestro-llm", kind: "language", latencyMs: 340, active: true },
    { name: "falstaff-vision", kind: "vision", latencyMs: 610, active: false },
  ]) {
    await rt.db.insert("models", doc);
  }
  await rt.db.checkpoint();
  await rt.db.recover();
  rt.log("info", "system", "Opera AI runtime ready");
}
