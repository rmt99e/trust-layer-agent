import type { ForgottenSession, Session } from "../session.js";
import { StaleSession, type SessionStore } from "../store.js";
import type { TraceSink } from "../trace.js";

/** The app's own query function. pg's `pool.query` fits as is; any client returning { rows, rowCount } works. */
export type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
export interface PostgresOptions {
  query: Query;
  sessions?: string;      // table, default tla_sessions; optionally schema-qualified
  traces?: string;        // table, default tla_traces
  mask?: boolean;         // passed to the agent: false means trace lines arrive unmasked
  onError?: (e: unknown) => void;   // trace writes are fire-and-forget; default: console.warn
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(name)) throw new TypeError(`postgres: "${name}" isn't a plain table name`);
  return name.split(".").map((p) => `"${p}"`).join(".");
};

/** Sessions and trace lines in two tables, through the app's own query function. Run `schema` once to create them. */
export function postgres(o: PostgresOptions): { store: SessionStore; trace: TraceSink; schema: string } {
  const S = ident(o.sessions ?? "tla_sessions"), T = ident(o.traces ?? "tla_traces");
  const warn = o.onError ?? ((e) => console.warn(`⚠️  postgres trace: ${(e as Error).message}`));
  const store: SessionStore = {
    async load(id) { return (await o.query(`SELECT session FROM ${S} WHERE id = $1`, [id])).rows[0]?.session; },
    async save(s: Session | ForgottenSession, expectedRev) {
      const row = [s.id, "forgotten" in s ? -1 : s.rev, "forgotten" in s ? "forgotten" : s.status, JSON.stringify(s)];
      const r = expectedRev === undefined
        ? await o.query(`INSERT INTO ${S} (id, rev, status, session) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, row)
        : await o.query(`UPDATE ${S} SET rev = $2, status = $3, session = $4, updated_at = now() WHERE id = $1 AND rev = $5`, [...row, expectedRev]);
      if (!r.rowCount) throw new StaleSession(s.id, expectedRev);
    },
  };
  const trace: TraceSink = {
    mask: o.mask,
    write: (line) => void o.query(`INSERT INTO ${T} (session_id, turn, type, line) VALUES ($1, $2, $3, $4)`,
      [line.sessionId, line.turn, line.type, JSON.stringify(line)]).catch(warn),
    forget: (sessionId) => void o.query(`DELETE FROM ${T} WHERE session_id = $1`, [sessionId]).catch(warn),
  };
  const schema = `CREATE TABLE IF NOT EXISTS ${S} (id text PRIMARY KEY, rev integer NOT NULL, status text NOT NULL, session jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ${T} (id bigserial PRIMARY KEY, session_id text NOT NULL, turn integer, type text NOT NULL, line jsonb NOT NULL, ts timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ${ident((o.traces ?? "tla_traces").replace(".", "_") + "_session")} ON ${T} (session_id);`;
  return { store, trace, schema };
}
