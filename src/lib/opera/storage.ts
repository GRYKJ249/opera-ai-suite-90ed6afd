// OperaCloud Storage Engine — streamed ingestion, AES-256-GCM encryption at
// rest, HTTP Range streaming, per-owner quotas and HMAC pre-signed URLs.

import { b64url, hmacSign, timingSafeEqual } from "./auth";

export type StoredFile = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  owner: string;
  createdAt: string;
  ivB64: string;
  checksum: string;
};

export const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GB

export class OperaCloud {
  readonly files = new Map<string, StoredFile>();
  private blobs = new Map<string, Uint8Array>(); // ciphertext at rest
  readonly quotas = new Map<string, number>();
  private keyPromise: Promise<CryptoKey>;
  private log: (level: string, msg: string, meta?: unknown) => void;

  constructor(
    private secret: string,
    logger: (level: string, msg: string, meta?: unknown) => void = () => {},
  ) {
    this.log = logger;
    this.keyPromise = this.deriveKey();
  }

  private async deriveKey(): Promise<CryptoKey> {
    const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.secret));
    return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  quotaFor(owner: string) {
    return this.quotas.get(owner) ?? DEFAULT_QUOTA_BYTES;
  }

  usageFor(owner: string) {
    let used = 0;
    for (const f of this.files.values()) if (f.owner === owner) used += f.size;
    return used;
  }

  setQuota(owner: string, bytes: number) {
    this.quotas.set(owner, bytes);
    return { owner, quota: bytes };
  }

  /** Consumes the request body stream chunk-by-chunk, then encrypts at rest. */
  async ingest(
    stream: ReadableStream<Uint8Array> | null,
    meta: { name: string; contentType: string; owner: string },
  ): Promise<StoredFile> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const quota = this.quotaFor(meta.owner);
    const used = this.usageFor(meta.owner);
    if (stream) {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        if (used + size > quota) {
          await reader.cancel();
          throw Object.assign(new Error("Storage quota exceeded"), { status: 413 });
        }
        chunks.push(value);
      }
    }
    const plain = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      plain.set(c, offset);
      offset += c.byteLength;
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.keyPromise;
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
    const digest = await crypto.subtle.digest("SHA-256", plain);
    const file: StoredFile = {
      id: crypto.randomUUID(),
      name: meta.name,
      contentType: meta.contentType || "application/octet-stream",
      size,
      owner: meta.owner,
      createdAt: new Date().toISOString(),
      ivB64: b64url(iv),
      checksum: b64url(digest).slice(0, 24),
    };
    this.files.set(file.id, file);
    this.blobs.set(file.id, cipher);
    this.log("info", `encrypted upload ${file.name}`, { id: file.id, bytes: size });
    return file;
  }

  async decrypt(id: string): Promise<Uint8Array | null> {
    const file = this.files.get(id);
    const cipher = this.blobs.get(id);
    if (!file || !cipher) return null;
    const key = await this.keyPromise;
    const iv = fromB64url(file.ivB64);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher));
  }

  /** Range-aware streaming download response. */
  async download(id: string, rangeHeader: string | null): Promise<Response> {
    const file = this.files.get(id);
    const plain = await this.decrypt(id);
    if (!file || !plain) return new Response("Not found", { status: 404 });

    const headersBase: Record<string, string> = {
      "content-type": file.contentType,
      "accept-ranges": "bytes",
      "content-disposition": `attachment; filename="${file.name.replace(/"/g, "")}"`,
      "x-opera-checksum": file.checksum,
    };

    const match = rangeHeader?.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), plain.length - 1) : plain.length - 1;
      if (start >= plain.length || start > end) {
        return new Response("Range not satisfiable", {
          status: 416,
          headers: { "content-range": `bytes */${plain.length}` },
        });
      }
      const slice = plain.slice(start, end + 1);
      this.log("info", `range download ${file.name}`, { start, end });
      return new Response(slice, {
        status: 206,
        headers: {
          ...headersBase,
          "content-range": `bytes ${start}-${end}/${plain.length}`,
          "content-length": String(slice.length),
        },
      });
    }

    this.log("info", `download ${file.name}`, { bytes: plain.length });
    return new Response(plain, {
      status: 200,
      headers: { ...headersBase, "content-length": String(plain.length) },
    });
  }

  remove(id: string) {
    const existed = this.files.delete(id);
    this.blobs.delete(id);
    return existed;
  }

  async presign(id: string, ttlSeconds = 300): Promise<{ url: string; expires: number }> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = await hmacSign(this.secret, `${id}.${expires}`);
    return { url: `/api/v1/opera-ai/storage/signed/${id}?expires=${expires}&signature=${sig}`, expires };
  }

  async verifySignature(id: string, expires: string | null, signature: string | null) {
    if (!expires || !signature) return false;
    if (Number(expires) * 1000 < Date.now()) return false;
    const expected = await hmacSign(this.secret, `${id}.${expires}`);
    return timingSafeEqual(signature, expected);
  }

  stats() {
    let bytes = 0;
    for (const f of this.files.values()) bytes += f.size;
    return { files: this.files.size, bytes, encryption: "AES-256-GCM", defaultQuota: DEFAULT_QUOTA_BYTES };
  }
}
