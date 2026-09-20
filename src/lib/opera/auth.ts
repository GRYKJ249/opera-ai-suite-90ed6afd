// Opera AI Auth — native password hashing (scrypt-family KDF) and
// hand-rolled HMAC-SHA256 JWT signing/verification. No auth libraries.

export type Role = "USER" | "ADMIN" | "SERVICE_BOT";
export const ROLES: Role[] = ["USER", "ADMIN", "SERVICE_BOT"];

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const pad = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------ passwords ------------------------------- */

const KDF_ITERATIONS = 150_000;

export async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex ? fromB64url(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: KDF_ITERATIONS },
    key,
    256,
  );
  return `opera$${KDF_ITERATIONS}$${b64url(salt)}$${b64url(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, , salt] = stored.split("$");
  if (!salt) return false;
  const candidate = await hashPassword(password, salt);
  return timingSafeEqual(candidate, stored);
}

/* --------------------------------- JWT ---------------------------------- */

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await hmacKey(secret);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export type JwtClaims = { sub: string; email: string; role: Role; iat: number; exp: number };

export async function signJwt(
  secret: string,
  claims: Omit<JwtClaims, "iat" | "exp">,
  ttlSeconds = 3600,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(
    enc.encode(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds } satisfies JwtClaims)),
  );
  const signature = await hmacSign(secret, `${header}.${body}`);
  return `${header}.${body}.${signature}`;
}

export async function verifyJwt(secret: string, token: string): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = await hmacSign(secret, `${header}.${body}`);
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as JwtClaims;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export { b64url, fromB64url, timingSafeEqual };
