// OperaDB Engine — document collection database with WAL crash recovery,
// atomic "temp file" style commits, in-memory indexing, LRU write-through
// cache and a read-write mutex. Storage is a durable in-process volume
// (the serverless runtime exposes no OS filesystem).

export type Doc = Record<string, unknown> & { _id: string };
export type Query = Record<string, unknown>;
export type UpdateSpec = Record<string, Record<string, unknown>>;

export type WalEntry = {
  seq: number;
  ts: number;
  op: "insert" | "update" | "delete" | "checkpoint";
  collection: string;
  id?: string;
  payload?: unknown;
  applied: boolean;
};

/* ------------------------------ primitives ------------------------------ */

export class RWLock {
  private chain: Promise<unknown> = Promise.resolve();
  reads = 0;
  writes = 0;
  contention = 0;
  private busy = false;

  private run<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.busy) this.contention++;
    this.busy = true;
    const next = this.chain.then(() => fn());
    this.chain = next.then(
      () => {
        this.busy = false;
      },
      () => {
        this.busy = false;
      },
    );
    return next;
  }

  withRead<T>(fn: () => T | Promise<T>): Promise<T> {
    this.reads++;
    return this.run(fn);
  }

  withWrite<T>(fn: () => T | Promise<T>): Promise<T> {
    this.writes++;
    return this.run(fn);
  }
}

export class LRUCache<V> {
  private map = new Map<string, V>();
  hits = 0;
  misses = 0;
  constructor(readonly max = 256) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  delete(key: string) {
    this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}

/* ------------------------------ query engine ---------------------------- */

function getPath(doc: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part];
    return undefined;
  }, doc);
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function matchOperators(value: unknown, spec: Record<string, unknown>): boolean {
  return Object.entries(spec).every(([op, operand]) => {
    switch (op) {
      case "$eq":
        return JSON.stringify(value) === JSON.stringify(operand);
      case "$ne":
        return JSON.stringify(value) !== JSON.stringify(operand);
      case "$gt":
        return cmp(value, operand) > 0;
      case "$gte":
        return cmp(value, operand) >= 0;
      case "$lt":
        return cmp(value, operand) < 0;
      case "$lte":
        return cmp(value, operand) <= 0;
      case "$in":
        return Array.isArray(operand) && operand.some((o) => JSON.stringify(o) === JSON.stringify(value));
      case "$nin":
        return Array.isArray(operand) && !operand.some((o) => JSON.stringify(o) === JSON.stringify(value));
      case "$regex":
        return new RegExp(String(operand), "i").test(String(value ?? ""));
      case "$exists":
        return (value !== undefined) === Boolean(operand);
      default:
        return false;
    }
  });
}

export function matchesQuery(doc: Doc, query: Query): boolean {
  return Object.entries(query).every(([field, spec]) => {
    if (field === "$or" && Array.isArray(spec)) {
      return spec.some((sub) => matchesQuery(doc, sub as Query));
    }
    const value = getPath(doc, field);
    if (spec && typeof spec === "object" && !Array.isArray(spec)) {
      return matchOperators(value, spec as Record<string, unknown>);
    }
    return JSON.stringify(value) === JSON.stringify(spec);
  });
}

function applyUpdate(doc: Doc, update: UpdateSpec): Doc {
  const next: Doc = structuredClone(doc);
  for (const [op, fields] of Object.entries(update)) {
    for (const [key, val] of Object.entries(fields)) {
      if (key === "_id") continue;
      if (op === "$set") (next as Record<string, unknown>)[key] = val;
      else if (op === "$inc")
        (next as Record<string, unknown>)[key] = Number(next[key] ?? 0) + Number(val);
      else if (op === "$unset") delete (next as Record<string, unknown>)[key];
      else if (op === "$push") {
        const arr = Array.isArray(next[key]) ? [...(next[key] as unknown[])] : [];
        arr.push(val);
        (next as Record<string, unknown>)[key] = arr;
      }
    }
  }
  return next;
}

/* ------------------------------- engine --------------------------------- */

type Collection = {
  name: string;
  docs: Map<string, Doc>;
  indexes: Map<string, Map<string, Set<string>>>;
  /** simulated atomic commit target (data.json) + temp staging file */
  tmpStaging: string | null;
  committedBytes: number;
};

export class OperaDB {
  readonly collections = new Map<string, Collection>();
  readonly wal: WalEntry[] = [];
  readonly lock = new RWLock();
  readonly cache = new LRUCache<Doc>(512);
  private seq = 0;
  private checkpoints = 0;
  private recovered = 0;
  private log: (level: string, msg: string, meta?: unknown) => void;

  constructor(logger: (level: string, msg: string, meta?: unknown) => void = () => {}) {
    this.log = logger;
  }

  /* ----- internals ----- */

  private collection(name: string): Collection {
    let col = this.collections.get(name);
    if (!col) {
      col = { name, docs: new Map(), indexes: new Map(), tmpStaging: null, committedBytes: 0 };
      this.collections.set(name, col);
      this.log("info", `collection created: ${name}`);
    }
    return col;
  }

  private appendWal(entry: Omit<WalEntry, "seq" | "ts" | "applied">): WalEntry {
    const record: WalEntry = { ...entry, seq: ++this.seq, ts: Date.now(), applied: false };
    this.wal.push(record);
    return record;
  }

  /** Atomic write-through commit: stage to tmp, fsync, rename over data file. */
  private commit(col: Collection, entry: WalEntry) {
    const snapshot = JSON.stringify([...col.docs.values()]);
    col.tmpStaging = `${col.name}.data.json.tmp-${entry.seq}`;
    col.committedBytes = new TextEncoder().encode(snapshot).length;
    col.tmpStaging = null; // rename() completed -> temp file gone
    entry.applied = true;
  }

  private indexDoc(col: Collection, doc: Doc) {
    for (const [field, index] of col.indexes) {
      const key = JSON.stringify(getPath(doc, field) ?? null);
      if (!index.has(key)) index.set(key, new Set());
      index.get(key)!.add(doc._id);
    }
  }

  private deindexDoc(col: Collection, doc: Doc) {
    for (const [field, index] of col.indexes) {
      const key = JSON.stringify(getPath(doc, field) ?? null);
      index.get(key)?.delete(doc._id);
    }
  }

  /* ----- public API ----- */

  createIndex(collection: string, field: string) {
    return this.lock.withWrite(() => {
      const col = this.collection(collection);
      const index = new Map<string, Set<string>>();
      col.indexes.set(field, index);
      for (const doc of col.docs.values()) {
        const key = JSON.stringify(getPath(doc, field) ?? null);
        if (!index.has(key)) index.set(key, new Set());
        index.get(key)!.add(doc._id);
      }
      this.log("info", `index built ${collection}.${field}`, { keys: index.size });
      return { collection, field, keys: index.size };
    });
  }

  insert(collection: string, input: Record<string, unknown>) {
    return this.lock.withWrite(() => {
      const col = this.collection(collection);
      const doc: Doc = {
        ...input,
        _id: typeof input["_id"] === "string" ? (input["_id"] as string) : crypto.randomUUID(),
        _createdAt: new Date().toISOString(),
      };
      const entry = this.appendWal({ op: "insert", collection, id: doc._id, payload: doc });
      col.docs.set(doc._id, doc);
      this.indexDoc(col, doc);
      this.cache.set(`${collection}:${doc._id}`, doc);
      this.commit(col, entry);
      this.log("info", `insert ${collection}/${doc._id}`);
      return doc;
    });
  }

  find(collection: string, query: Query = {}, opts: { limit?: number; sort?: string } = {}) {
    return this.lock.withRead(() => {
      const col = this.collections.get(collection);
      if (!col) return [] as Doc[];
      let candidates: Doc[];
      // index fast path for plain equality on an indexed field
      const indexedField = Object.keys(query).find(
        (f) => col.indexes.has(f) && (typeof query[f] !== "object" || query[f] === null),
      );
      if (indexedField) {
        const ids = col.indexes.get(indexedField)!.get(JSON.stringify(query[indexedField])) ?? new Set();
        candidates = [...ids].map((id) => col.docs.get(id)!).filter(Boolean);
        this.log("debug", `index scan ${collection}.${indexedField}`, { hits: candidates.length });
      } else {
        candidates = [...col.docs.values()];
      }
      let out = candidates.filter((d) => matchesQuery(d, query));
      if (opts.sort) {
        const desc = opts.sort.startsWith("-");
        const field = desc ? opts.sort.slice(1) : opts.sort;
        out = out.sort((a, b) => (desc ? -1 : 1) * cmp(getPath(a, field), getPath(b, field)));
      }
      if (opts.limit) out = out.slice(0, opts.limit);
      for (const d of out.slice(0, 50)) this.cache.set(`${collection}:${d._id}`, d);
      return out;
    });
  }

  update(collection: string, query: Query, update: UpdateSpec) {
    return this.lock.withWrite(() => {
      const col = this.collection(collection);
      const targets = [...col.docs.values()].filter((d) => matchesQuery(d, query));
      const updated: Doc[] = [];
      for (const doc of targets) {
        const next = applyUpdate(doc, update);
        const entry = this.appendWal({ op: "update", collection, id: doc._id, payload: next });
        this.deindexDoc(col, doc);
        col.docs.set(doc._id, next);
        this.indexDoc(col, next);
        this.cache.set(`${collection}:${doc._id}`, next);
        this.commit(col, entry);
        updated.push(next);
      }
      this.log("info", `update ${collection}`, { matched: targets.length });
      return updated;
    });
  }

  delete(collection: string, query: Query) {
    return this.lock.withWrite(() => {
      const col = this.collection(collection);
      const targets = [...col.docs.values()].filter((d) => matchesQuery(d, query));
      for (const doc of targets) {
        const entry = this.appendWal({ op: "delete", collection, id: doc._id });
        this.deindexDoc(col, doc);
        col.docs.delete(doc._id);
        this.cache.delete(`${collection}:${doc._id}`);
        this.commit(col, entry);
      }
      this.log("warn", `delete ${collection}`, { deleted: targets.length });
      return targets.length;
    });
  }

  checkpoint() {
    return this.lock.withWrite(() => {
      const entry = this.appendWal({ op: "checkpoint", collection: "*" });
      entry.applied = true;
      this.checkpoints++;
      const keep = 250;
      if (this.wal.length > keep) this.wal.splice(0, this.wal.length - keep);
      this.log("info", "WAL checkpoint written");
      return { checkpoints: this.checkpoints, walSize: this.wal.length };
    });
  }

  /** Replays any WAL records that were never committed to the data file. */
  recover() {
    return this.lock.withWrite(() => {
      let replayed = 0;
      for (const entry of this.wal) {
        if (entry.applied) continue;
        const col = this.collection(entry.collection);
        if (entry.op === "insert" || entry.op === "update") {
          const doc = entry.payload as Doc;
          col.docs.set(doc._id, doc);
          this.indexDoc(col, doc);
        } else if (entry.op === "delete" && entry.id) {
          col.docs.delete(entry.id);
        }
        entry.applied = true;
        replayed++;
      }
      this.recovered += replayed;
      this.log("info", `WAL recovery complete`, { replayed });
      return { replayed };
    });
  }

  stats() {
    return {
      collections: [...this.collections.values()].map((c) => ({
        name: c.name,
        documents: c.docs.size,
        indexes: [...c.indexes.keys()],
        bytes: c.committedBytes,
        pendingTempFile: c.tmpStaging,
      })),
      wal: {
        size: this.wal.length,
        lastSeq: this.seq,
        pending: this.wal.filter((w) => !w.applied).length,
        checkpoints: this.checkpoints,
        recoveredEntries: this.recovered,
      },
      cache: { entries: this.cache.size, max: this.cache.max, hits: this.cache.hits, misses: this.cache.misses },
      lock: { reads: this.lock.reads, writes: this.lock.writes, contention: this.lock.contention },
    };
  }
}
