import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API = "/api/v1/opera-ai";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Opera AI Studio — OperaDB, OperaCloud & RBAC Control Center" },
      {
        name: "description",
        content:
          "Interactive control center for the Opera AI ecosystem: run OperaDB queries, inspect WAL status, stream AES-256-GCM encrypted files, manage roles and test the REST API.",
      },
      { property: "og:title", content: "Opera AI Studio" },
      {
        property: "og:description",
        content:
          "Run OperaDB queries, inspect WAL and cache state, upload encrypted files and test the Opera AI REST API from one console.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Studio,
});

/* ------------------------------ primitives ------------------------------ */

type Session = { token: string; email: string; role: string } | null;

const TABS = ["Overview", "Database", "Storage", "Access", "API", "Logs"] as const;
type Tab = (typeof TABS)[number];

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function Panel({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-card/60 backdrop-blur-sm">
      <header className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-foreground uppercase">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
        {actions}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Button({
  children,
  onClick,
  variant = "primary",
  type = "button",
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  const styles = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90",
    ghost: "border border-border bg-background text-foreground hover:bg-accent",
    danger: "bg-destructive text-white hover:bg-destructive/90",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-medium text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
      />
    </label>
  );
}

function Code({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/60 p-4">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/* --------------------------------- app ---------------------------------- */

function Studio() {
  const [session, setSession] = useState<Session>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [status, setStatus] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (session) headers.set("authorization", `Bearer ${session.token}`);
      if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      const res = await fetch(`${API}${path}`, { ...init, headers });
      const text = await res.text();
      try {
        return { status: res.status, data: JSON.parse(text) };
      } catch {
        return { status: res.status, data: text };
      }
    },
    [session],
  );

  const refresh = useCallback(async () => {
    const [s, l] = await Promise.all([call("/system/status"), call("/system/logs")]);
    setStatus(s.data);
    setLogs(Array.isArray(l.data) ? l.data : []);
  }, [call]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 4000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const notify = (m: string) => setToast(m);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-64 bg-gradient-to-b from-primary/10 to-transparent" />
      <div className="relative mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8">
        <Header session={session} onSignOut={() => setSession(null)} status={status} />

        <nav className="flex flex-wrap gap-1 rounded-lg border border-border/60 bg-card/50 p-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        {tab === "Overview" && <Overview status={status} logs={logs} call={call} notify={notify} />}
        {tab === "Database" && <Database call={call} notify={notify} status={status} />}
        {tab === "Storage" && <Storage call={call} notify={notify} session={session} />}
        {tab === "Access" && (
          <Access call={call} notify={notify} session={session} setSession={setSession} />
        )}
        {tab === "API" && <ApiTester call={call} />}
        {tab === "Logs" && <Logs logs={logs} onRefresh={() => void refresh()} />}
      </div>

      {toast ? (
        <div className="fixed right-6 bottom-6 rounded-md border border-border bg-card px-4 py-2 text-xs text-foreground shadow-lg">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function Header({
  session,
  onSignOut,
  status,
}: {
  session: Session;
  onSignOut: () => void;
  status: any;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <p className="text-[11px] font-semibold tracking-[0.3em] text-primary uppercase">Opera AI</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Studio Control Center</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          OperaDB engine · OperaCloud AES-256-GCM storage · native JWT auth &amp; RBAC
        </p>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span className="rounded-full border border-border/70 bg-card px-3 py-1 text-muted-foreground">
          uptime {status?.uptimeSeconds ?? 0}s
        </span>
        {session ? (
          <>
            <span className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1 font-medium text-primary">
              {session.email} · {session.role}
            </span>
            <Button variant="ghost" onClick={onSignOut}>
              Sign out
            </Button>
          </>
        ) : (
          <span className="rounded-full border border-border/70 bg-card px-3 py-1 text-muted-foreground">
            anonymous — sign in under Access
          </span>
        )}
      </div>
    </header>
  );
}

/* ------------------------------- overview -------------------------------- */

function Overview({
  status,
  logs,
  call,
  notify,
}: {
  status: any;
  logs: any[];
  call: any;
  notify: (m: string) => void;
}) {
  const db = status?.db;
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Collections"
          value={String(db?.collections?.length ?? 0)}
          hint={`${db?.collections?.reduce((a: number, c: any) => a + c.documents, 0) ?? 0} documents`}
        />
        <Stat
          label="WAL entries"
          value={String(db?.wal?.size ?? 0)}
          hint={`${db?.wal?.pending ?? 0} pending · seq ${db?.wal?.lastSeq ?? 0}`}
        />
        <Stat
          label="LRU cache"
          value={`${db?.cache?.entries ?? 0}/${db?.cache?.max ?? 0}`}
          hint={`${db?.cache?.hits ?? 0} hits · ${db?.cache?.misses ?? 0} misses`}
        />
        <Stat
          label="Encrypted objects"
          value={String(status?.storage?.files ?? 0)}
          hint={`${bytes(status?.storage?.bytes ?? 0)} at rest · AES-256-GCM`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Collections"
          subtitle="Documents, indexes and committed data-file size"
          actions={
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={async () => {
                  await call("/db/checkpoint", { method: "POST" });
                  notify("WAL checkpoint written");
                }}
              >
                Checkpoint
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  const r = await call("/db/recover", { method: "POST" });
                  notify(`Recovery replayed ${r.data.replayed} entries`);
                }}
              >
                Replay WAL
              </Button>
            </div>
          }
        >
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="pb-2">Name</th>
                <th className="pb-2">Docs</th>
                <th className="pb-2">Indexes</th>
                <th className="pb-2">Size</th>
              </tr>
            </thead>
            <tbody>
              {(db?.collections ?? []).map((c: any) => (
                <tr key={c.name} className="border-t border-border/50">
                  <td className="py-2 font-medium">{c.name}</td>
                  <td className="py-2">{c.documents}</td>
                  <td className="py-2 font-mono text-[11px] text-muted-foreground">
                    {c.indexes.join(", ") || "—"}
                  </td>
                  <td className="py-2">{bytes(c.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Live activity" subtitle="Most recent engine events">
          <div className="space-y-1.5">
            {logs.slice(0, 12).map((l, i) => (
              <div key={i} className="flex gap-2 font-mono text-[11px]">
                <span className="text-muted-foreground">{l.ts?.slice(11, 19)}</span>
                <span
                  className={
                    l.level === "error"
                      ? "text-destructive"
                      : l.level === "warn"
                        ? "text-amber-500"
                        : "text-primary"
                  }
                >
                  {l.scope}
                </span>
                <span className="truncate">{l.message}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------- database -------------------------------- */

function Database({ call, notify, status }: { call: any; notify: (m: string) => void; status: any }) {
  const [collection, setCollection] = useState("models");
  const [query, setQuery] = useState('{ "latencyMs": { "$lt": 500 } }');
  const [update, setUpdate] = useState('{ "$inc": { "latencyMs": -10 } }');
  const [doc, setDoc] = useState('{ "name": "verdi-embed", "kind": "embedding", "latencyMs": 45 }');
  const [result, setResult] = useState<unknown>("Run a query to see results.");
  const [wal, setWal] = useState<any[]>([]);

  const parse = (v: string) => {
    try {
      return JSON.parse(v);
    } catch {
      notify("Invalid JSON");
      return null;
    }
  };

  const run = async (action: string, payload: Record<string, unknown>) => {
    const r = await call(`/db/${collection}/${action}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setResult(r.data);
    notify(`${action} → HTTP ${r.status}`);
    const w = await call("/db/wal");
    setWal(Array.isArray(w.data) ? w.data : []);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
      <Panel title="Query console" subtitle="$eq $ne $gt $gte $lt $lte $in $nin $regex $exists · $set $inc $unset $push">
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Collection" value={collection} onChange={setCollection} />
            <div className="flex items-end gap-2">
              <Button
                variant="ghost"
                onClick={async () => {
                  const r = await call(`/db/${collection}/index`, {
                    method: "POST",
                    body: JSON.stringify({ field: "name" }),
                  });
                  notify(`Index on name → ${r.data.keys ?? 0} keys`);
                }}
              >
                Index "name"
              </Button>
            </div>
          </div>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-muted-foreground">Filter (JSON)</span>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus:border-ring"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-muted-foreground">Update spec (JSON)</span>
            <textarea
              value={update}
              onChange={(e) => setUpdate(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus:border-ring"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-muted-foreground">Insert document (JSON)</span>
            <textarea
              value={doc}
              onChange={(e) => setDoc(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus:border-ring"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                const q = parse(query);
                if (q) void run("find", { query: q, limit: 50 });
              }}
            >
              Find
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                const d = parse(doc);
                if (d) void run("insert", { doc: d });
              }}
            >
              Insert
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                const q = parse(query);
                const u = parse(update);
                if (q && u) void run("update", { query: q, update: u });
              }}
            >
              Update
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const q = parse(query);
                if (q) void run("delete", { query: q });
              }}
            >
              Delete
            </Button>
          </div>
          <Code value={result} />
        </div>
      </Panel>

      <div className="grid gap-6">
        <Panel
          title="Write-ahead log"
          subtitle={`seq ${status?.db?.wal?.lastSeq ?? 0} · ${status?.db?.wal?.pending ?? 0} uncommitted · ${status?.db?.wal?.checkpoints ?? 0} checkpoints`}
          actions={
            <Button
              variant="ghost"
              onClick={async () => {
                const w = await call("/db/wal");
                setWal(Array.isArray(w.data) ? w.data : []);
              }}
            >
              Load WAL
            </Button>
          }
        >
          <div className="max-h-96 space-y-1 overflow-auto font-mono text-[11px]">
            {wal.length === 0 ? <p className="text-muted-foreground">No WAL entries loaded.</p> : null}
            {wal.map((e) => (
              <div key={e.seq} className="flex gap-2 border-b border-border/40 py-1">
                <span className="text-muted-foreground">#{e.seq}</span>
                <span className="text-primary">{e.op}</span>
                <span>{e.collection}</span>
                <span className="ml-auto text-muted-foreground">
                  {e.applied ? "committed" : "pending"}
                </span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Engine internals" subtitle="Lock + cache counters">
          <Code value={{ lock: status?.db?.lock, cache: status?.db?.cache }} />
        </Panel>
      </div>
    </div>
  );
}

/* -------------------------------- storage -------------------------------- */

function Storage({
  call,
  notify,
  session,
}: {
  call: any;
  notify: (m: string) => void;
  session: Session;
}) {
  const [files, setFiles] = useState<any[]>([]);
  const [quota, setQuota] = useState<any>(null);
  const [range, setRange] = useState("bytes=0-63");
  const [preview, setPreview] = useState<unknown>("Upload or fetch a file to inspect bytes.");
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!session) return;
    const [f, q] = await Promise.all([call("/storage/files"), call("/storage/quota")]);
    setFiles(Array.isArray(f.data) ? f.data : []);
    setQuota(q.data);
  }, [call, session]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!session)
    return (
      <Panel title="OperaCloud" subtitle="Sign in under Access to upload encrypted objects">
        <p className="text-sm text-muted-foreground">
          Storage operations require a bearer token from the auth engine.
        </p>
      </Panel>
    );

  const upload = async (file: File) => {
    const res = await fetch(`${API}/storage/upload`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": file.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
      },
      body: file,
    });
    const data = await res.json();
    notify(res.ok ? `Encrypted ${file.name}` : `Upload failed: ${data.error}`);
    setPreview(data);
    void load();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Panel
        title="Encrypted ingestion"
        subtitle="Streamed chunk-by-chunk, sealed with AES-256-GCM before it lands at rest"
        actions={
          <Button onClick={() => inputRef.current?.click()}>Upload file</Button>
        }
      >
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <div className="grid gap-3">
          <div className="rounded-lg border border-border/60 p-4">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Quota used</span>
              <span>
                {bytes(quota?.used ?? 0)} / {bytes(quota?.quota ?? 0)}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary"
                style={{
                  width: `${Math.min(100, ((quota?.used ?? 0) / (quota?.quota || 1)) * 100).toFixed(4)}%`,
                }}
              />
            </div>
          </div>
          <Field label="Range header" value={range} onChange={setRange} placeholder="bytes=0-63" />
          <Code value={preview} />
        </div>
      </Panel>

      <Panel title="Objects" subtitle="Download, range-stream or mint a signed URL" actions={<Button variant="ghost" onClick={() => void load()}>Refresh</Button>}>
        <div className="space-y-3">
          {files.length === 0 ? (
            <p className="text-xs text-muted-foreground">No objects stored yet.</p>
          ) : null}
          {files.map((f) => (
            <div key={f.id} className="rounded-lg border border-border/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{f.name}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {bytes(f.size)} · {f.contentType} · sha256 {f.checksum}
                  </p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const res = await fetch(`${API}/storage/download/${f.id}`, {
                      headers: { authorization: `Bearer ${session.token}` },
                    });
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = f.name;
                    a.click();
                    URL.revokeObjectURL(url);
                    notify(`Decrypted and downloaded ${f.name}`);
                  }}
                >
                  Download
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const res = await fetch(`${API}/storage/download/${f.id}`, {
                      headers: { authorization: `Bearer ${session.token}`, range },
                    });
                    const text = await res.text();
                    setPreview({
                      status: res.status,
                      contentRange: res.headers.get("content-range"),
                      body: text.slice(0, 400),
                    });
                    notify(`Range request → HTTP ${res.status}`);
                  }}
                >
                  Range stream
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const r = await call("/storage/presign", {
                      method: "POST",
                      body: JSON.stringify({ fileId: f.id, ttl: 300 }),
                    });
                    setPreview(r.data);
                    notify("Signed URL valid for 5 minutes");
                  }}
                >
                  Pre-sign
                </Button>
                <Button
                  variant="danger"
                  onClick={async () => {
                    await call(`/storage/delete/${f.id}`, { method: "POST" });
                    notify("Object removed");
                    void load();
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* --------------------------------- access -------------------------------- */

function Access({
  call,
  notify,
  session,
  setSession,
}: {
  call: any;
  notify: (m: string) => void;
  session: Session;
  setSession: (s: Session) => void;
}) {
  const [email, setEmail] = useState("admin@opera.ai");
  const [password, setPassword] = useState("opera-admin");
  const [role, setRole] = useState("USER");
  const [users, setUsers] = useState<any[]>([]);
  const [out, setOut] = useState<unknown>("Sign in to inspect the issued JWT.");

  const loadUsers = useCallback(async () => {
    const r = await call("/auth/users");
    setUsers(Array.isArray(r.data) ? r.data : []);
  }, [call]);

  useEffect(() => {
    if (session?.role === "ADMIN") void loadUsers();
  }, [session, loadUsers]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Authentication" subtitle="PBKDF2-SHA256 password hashing · HS256 JWT signed in-engine">
        <div className="grid gap-3">
          <Field label="Email" value={email} onChange={setEmail} />
          <Field label="Password" value={password} onChange={setPassword} type="password" />
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-muted-foreground">Role (registration)</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option>USER</option>
              <option>ADMIN</option>
              <option>SERVICE_BOT</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={async () => {
                const r = await call("/auth/login", {
                  method: "POST",
                  body: JSON.stringify({ email, password }),
                });
                setOut(r.data);
                if (r.data.token) {
                  setSession({ token: r.data.token, email: r.data.email, role: r.data.role });
                  notify(`Signed in as ${r.data.role}`);
                } else notify("Login failed");
              }}
            >
              Sign in
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                const r = await call("/auth/register", {
                  method: "POST",
                  body: JSON.stringify({ email, password, role }),
                });
                setOut(r.data);
                notify(`Register → HTTP ${r.status}`);
              }}
            >
              Register
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                const r = await call("/auth/me");
                setOut(r.data);
                notify(`Token check → HTTP ${r.status}`);
              }}
            >
              Verify token
            </Button>
          </div>
          <Code value={out} />
          <p className="text-[11px] text-muted-foreground">
            Seeded accounts: admin@opera.ai / opera-admin · user@opera.ai / opera-user · bot@opera.ai /
            opera-bot
          </p>
        </div>
      </Panel>

      <Panel
        title="Users & quotas"
        subtitle="ADMIN-only view backed by RBAC on the endpoint"
        actions={<Button variant="ghost" onClick={() => void loadUsers()}>Reload</Button>}
      >
        {session?.role !== "ADMIN" ? (
          <p className="text-xs text-muted-foreground">Sign in with an ADMIN account to list users.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="pb-2">Email</th>
                <th className="pb-2">Role</th>
                <th className="pb-2">Storage</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-border/50">
                  <td className="py-2">{u.email}</td>
                  <td className="py-2">
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px]">
                      {u.role}
                    </span>
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {bytes(u.used)} / {bytes(u.quota)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

/* ------------------------------- api tester ------------------------------ */

const ENDPOINTS = [
  "GET /system/status",
  "GET /system/logs",
  "GET /db/collections",
  "GET /db/wal",
  "POST /db/checkpoint",
  "POST /db/models/find",
  "POST /auth/login",
  "GET /auth/me",
  "GET /auth/users",
  "GET /storage/files",
  "GET /storage/quota",
];

function ApiTester({ call }: { call: any }) {
  const [endpoint, setEndpoint] = useState(ENDPOINTS[0]!);
  const [payload, setPayload] = useState('{ "query": {} }');
  const [response, setResponse] = useState<unknown>("Send a request to see the response.");
  const [code, setCode] = useState<number | null>(null);

  const [method, path] = useMemo(() => endpoint.split(" ") as [string, string], [endpoint]);

  return (
    <Panel title="REST API tester" subtitle={`All routes are served under ${API}`}>
      <div className="grid gap-3">
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-muted-foreground">Endpoint</span>
          <select
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          >
            {ENDPOINTS.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </select>
        </label>
        {method === "POST" ? (
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-muted-foreground">Request body</span>
            <textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            />
          </label>
        ) : null}
        <div>
          <Button
            onClick={async () => {
              const init: RequestInit = { method };
              if (method === "POST") init.body = payload;
              const r = await call(path, init);
              setCode(r.status);
              setResponse(r.data);
            }}
          >
            Send request
          </Button>
        </div>
        {code !== null ? (
          <p className="font-mono text-xs text-muted-foreground">
            HTTP {code} · {method} {API}
            {path}
          </p>
        ) : null}
        <Code value={response} />
      </div>
    </Panel>
  );
}

/* ---------------------------------- logs --------------------------------- */

function Logs({ logs, onRefresh }: { logs: any[]; onRefresh: () => void }) {
  return (
    <Panel
      title="System logs"
      subtitle="Live ring buffer across the database, storage and auth engines"
      actions={<Button variant="ghost" onClick={onRefresh}>Refresh</Button>}
    >
      <div className="max-h-[32rem] space-y-1 overflow-auto font-mono text-[11px]">
        {logs.map((l, i) => (
          <div key={i} className="flex gap-3 border-b border-border/40 py-1">
            <span className="text-muted-foreground">{l.ts?.replace("T", " ").slice(0, 19)}</span>
            <span
              className={`w-12 ${
                l.level === "error"
                  ? "text-destructive"
                  : l.level === "warn"
                    ? "text-amber-500"
                    : "text-primary"
              }`}
            >
              {l.level}
            </span>
            <span className="w-24 text-muted-foreground">{l.scope}</span>
            <span className="flex-1">{l.message}</span>
            {l.meta ? (
              <span className="text-muted-foreground">{JSON.stringify(l.meta)}</span>
            ) : null}
          </div>
        ))}
      </div>
    </Panel>
  );
}
