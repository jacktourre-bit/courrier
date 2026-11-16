import pg from "pg";
import type { Scope } from "../domain/types.js";
import { PostalError } from "../lib/errors.js";
import { assertRowInScope, NULLABLE_ENTITY, UNIQUES, type Db, type FindOpts, type Table, type Where } from "./db.js";

// Horodatages renvoyés en ISO UTC, dates civiles en texte, bigint en nombre.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
pg.types.setTypeParser(1114, (v) => new Date(`${v}Z`).toISOString());
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Identifiant SQL invalide: ${s}`);
  return `"${s}"`;
};

function toDbValue(key: string, v: unknown): unknown {
  // Convention : toute propriété suffixée `Json` est une colonne jsonb.
  if (key.endsWith("Json")) return v === undefined || v === null ? null : JSON.stringify(v);
  return v === undefined ? null : v;
}

function fromRow<T>(r: Record<string, unknown>): T {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) o[camel(k)] = v;
  return o as T;
}

type Queryable = Pick<pg.PoolClient, "query">;

function buildWhere(where: Where, params: unknown[]): string {
  const parts: string[] = [];
  for (const [k, cond] of Object.entries(where)) {
    const col = ident(snake(k));
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) {
        params.push(c.in);
        parts.push(`${col} = ANY($${params.length})`);
      }
      if ("lte" in c) {
        params.push(c.lte);
        parts.push(`${col} <= $${params.length}`);
      }
      if ("lt" in c) {
        params.push(c.lt);
        parts.push(`${col} < $${params.length}`);
      }
      if ("gte" in c) {
        params.push(c.gte);
        parts.push(`${col} >= $${params.length}`);
      }
      if ("ne" in c) {
        params.push(c.ne);
        parts.push(`${col} IS DISTINCT FROM $${params.length}`);
      }
      if ("isNull" in c) parts.push(`${col} IS ${c.isNull ? "" : "NOT "}NULL`);
    } else if (cond === null) {
      parts.push(`${col} IS NULL`);
    } else {
      params.push(toDbValue(k, cond));
      parts.push(`${col} = $${params.length}`);
    }
  }
  return parts.length ? parts.join(" AND ") : "TRUE";
}

export class PgDb implements Db {
  constructor(
    private readonly pool: pg.Pool,
    readonly scope: Scope,
    private readonly client: Queryable | null = null,
  ) {}

  withScope(scope: Scope): Db {
    return new PgDb(this.pool, scope);
  }

  /** Filtre applicatif (défense en profondeur ; la RLS applique le même). */
  private scopeSql(table: Table, params: unknown[]): string {
    const parts: string[] = [];
    if (this.scope.tenantId !== "*") {
      params.push(this.scope.tenantId);
      parts.push(`tenant_id = $${params.length}`);
    }
    if (this.scope.legalEntityIds !== "*") {
      params.push(this.scope.legalEntityIds);
      parts.push(NULLABLE_ENTITY.includes(table) ? `(legal_entity_id IS NULL OR legal_entity_id = ANY($${params.length}))` : `legal_entity_id = ANY($${params.length})`);
    }
    return parts.length ? parts.join(" AND ") : "TRUE";
  }

  private async setContext(c: Queryable) {
    const s = this.scope;
    await c.query("SELECT set_config('postal.tenant_id', $1, true), set_config('postal.legal_entity_ids', $2, true), set_config('postal.is_system', $3, true), set_config('postal.user_id', $4, true)", [
      s.tenantId === "*" ? "" : s.tenantId,
      s.legalEntityIds === "*" ? "" : s.legalEntityIds.join(","),
      s.legalEntityIds === "*" ? "on" : "off",
      s.userId ?? "",
    ]);
  }

  private async run<R>(fn: (c: Queryable) => Promise<R>): Promise<R> {
    if (this.client) return fn(this.client);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await this.setContext(c);
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw mapPgError(e);
    } finally {
      c.release();
    }
  }

  async tx<R>(fn: (db: Db) => Promise<R>): Promise<R> {
    if (this.client) return fn(this);
    return this.run((c) => fn(new PgDb(this.pool, this.scope, c)));
  }

  async insert<T extends object>(table: Table, row: T): Promise<T> {
    assertRowInScope(this.scope, table, row as Record<string, unknown>);
    const keys = Object.keys(row).filter((k) => (row as Record<string, unknown>)[k] !== undefined);
    const params = keys.map((k) => toDbValue(k, (row as Record<string, unknown>)[k]));
    const sql = `INSERT INTO ${ident(table)} (${keys.map((k) => ident(snake(k))).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`;
    try {
      const r = await this.run((c) => c.query(sql, params));
      return fromRow<T>(r.rows[0]);
    } catch (e) {
      throw mapPgError(e);
    }
  }

  async insertIgnore<T extends object>(table: Table, row: T): Promise<boolean> {
    assertRowInScope(this.scope, table, row as Record<string, unknown>);
    const keys = Object.keys(row).filter((k) => (row as Record<string, unknown>)[k] !== undefined);
    const params = keys.map((k) => toDbValue(k, (row as Record<string, unknown>)[k]));
    const sql = `INSERT INTO ${ident(table)} (${keys.map((k) => ident(snake(k))).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) ON CONFLICT DO NOTHING`;
    if (!UNIQUES[table]) throw new Error(`insertIgnore sans contrainte d'unicité sur ${table}`);
    const r = await this.run((c) => c.query(sql, params));
    return (r.rowCount ?? 0) > 0;
  }

  async update(table: Table, where: Where, patch: Record<string, unknown>): Promise<number> {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!keys.length) return 0;
    const params: unknown[] = keys.map((k) => toDbValue(k, patch[k]));
    const set = keys.map((k, i) => `${ident(snake(k))} = $${i + 1}`).join(", ");
    const w = buildWhere(where, params);
    const s = this.scopeSql(table, params);
    const r = await this.run((c) => c.query(`UPDATE ${ident(table)} SET ${set} WHERE ${w} AND ${s}`, params));
    return r.rowCount ?? 0;
  }

  async find<T>(table: Table, where: Where = {}, opts: FindOpts = {}): Promise<T[]> {
    const params: unknown[] = [];
    const w = buildWhere(where, params);
    const s = this.scopeSql(table, params);
    const order = opts.orderBy?.length ? ` ORDER BY ${opts.orderBy.map(([c, d]) => `${ident(snake(c))} ${d === "asc" ? "ASC" : "DESC"}`).join(", ")}` : "";
    const lim = opts.limit !== undefined ? ` LIMIT ${Number(opts.limit) | 0}` : "";
    const off = opts.offset ? ` OFFSET ${Number(opts.offset) | 0}` : "";
    const r = await this.run((c) => c.query(`SELECT * FROM ${ident(table)} WHERE ${w} AND ${s}${order}${lim}${off}`, params));
    return r.rows.map((x) => fromRow<T>(x));
  }

  async one<T>(table: Table, where: Where): Promise<T | null> {
    return (await this.find<T>(table, where, { limit: 1 }))[0] ?? null;
  }

  async count(table: Table, where: Where = {}): Promise<number> {
    const params: unknown[] = [];
    const w = buildWhere(where, params);
    const s = this.scopeSql(table, params);
    const r = await this.run((c) => c.query(`SELECT count(*)::int AS n FROM ${ident(table)} WHERE ${w} AND ${s}`, params));
    return r.rows[0].n as number;
  }

  async sum(table: Table, column: string, where: Where = {}): Promise<number> {
    const params: unknown[] = [];
    const w = buildWhere(where, params);
    const s = this.scopeSql(table, params);
    const r = await this.run((c) => c.query(`SELECT coalesce(sum(${ident(snake(column))}),0)::bigint AS n FROM ${ident(table)} WHERE ${w} AND ${s}`, params));
    return Number(r.rows[0].n);
  }

  async claimOutbox(nowIso: string, limit: number, lockMs: number) {
    const params: unknown[] = [nowIso, new Date(Date.parse(nowIso) + lockMs).toISOString(), limit];
    const s = this.scopeSql("postal_outbox", params);
    const sql = `
      UPDATE postal_outbox o SET status = 'processing', locked_until = $2
      WHERE o.id IN (
        SELECT id FROM postal_outbox
        WHERE ((status = 'pending') OR (status = 'processing' AND locked_until < $1)) AND next_retry_at <= $1 AND ${s}
        ORDER BY next_retry_at
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`;
    const r = await this.run((c) => c.query(sql, params));
    return r.rows.map((x) => fromRow<Record<string, unknown>>(x));
  }
}

function mapPgError(e: unknown): unknown {
  const code = (e as { code?: string })?.code;
  if (code === "23505") return new PostalError("CONFLICT", "Contrainte d'unicité");
  if (code === "42501") return new PostalError("FORBIDDEN", "Refus RLS");
  return e;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}
