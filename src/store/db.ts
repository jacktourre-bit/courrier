/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Accès aux données. Deux versions avec les mêmes fonctions : une en mémoire (pour les tests)
 * et une PostgreSQL (pour la vraie vie). Chaque lecture et écriture est automatiquement
 * limitée à la société de l'utilisateur : impossible de voir ou modifier les données d'une
 * autre société.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { Scope } from "../domain/types.js";
import { PostalError } from "../lib/errors.js";

/**
 * Accès aux données minimal, commun à la base mémoire (tests, démo) et à
 * PostgreSQL. Toutes les opérations sont restreintes au `Scope` : filtre
 * tenant + entités juridiques côté application, doublé par la RLS PostgreSQL.
 */
export type Cond = { in: unknown[] } | { lte: unknown } | { gte: unknown } | { lt: unknown } | { isNull: boolean } | { ne: unknown };
export type Where = Record<string, unknown>;
export interface FindOpts {
  orderBy?: [string, "asc" | "desc"][];
  limit?: number;
  offset?: number;
}

export interface Db {
  readonly scope: Scope;
  insert<T extends object>(table: Table, row: T): Promise<T>;
  /** Insère si aucune ligne ne viole la contrainte d'unicité ; renvoie false sinon. */
  insertIgnore<T extends object>(table: Table, row: T): Promise<boolean>;
  update(table: Table, where: Where, patch: Record<string, unknown>): Promise<number>;
  find<T>(table: Table, where?: Where, opts?: FindOpts): Promise<T[]>;
  one<T>(table: Table, where: Where): Promise<T | null>;
  count(table: Table, where?: Where): Promise<number>;
  sum(table: Table, column: string, where?: Where): Promise<number>;
  tx<R>(fn: (db: Db) => Promise<R>): Promise<R>;
  /** Réserve des éléments d'outbox dus (FOR UPDATE SKIP LOCKED en PostgreSQL). */
  claimOutbox(nowIso: string, limit: number, lockMs: number): Promise<Record<string, unknown>[]>;
  withScope(scope: Scope): Db;
}

export const TABLES = [
  "postal_provider_connections",
  "postal_sender_profiles",
  "postal_subjects",
  "postal_recipient_addresses",
  "postal_contact_preferences",
  "postal_organizations",
  "postal_templates",
  "postal_template_versions",
  "postal_campaigns",
  "postal_campaign_recipients",
  "postal_dispatches",
  "postal_attachments",
  "postal_assets",
  "postal_events",
  "postal_evidence",
  "postal_approvals",
  "postal_outbox",
  "postal_audit_logs",
  "postal_budgets",
  "postal_sensitive_authorizations",
  "postal_webhook_receipts",
  "postal_human_tasks",
  "postal_retention_policies",
] as const;
export type Table = (typeof TABLES)[number];

/** Contraintes d'unicité métier (reproduites à l'identique dans la migration SQL). */
export const UNIQUES: Partial<Record<Table, string[][]>> = {
  postal_dispatches: [["tenantId", "idempotencyKey"]],
  postal_events: [["provider", "providerEventId", "dispatchId"]],
  postal_campaign_recipients: [["campaignId", "eventKey", "year", "subjectId"]],
  postal_webhook_receipts: [["provider", "dedupKey"]],
  postal_template_versions: [["templateId", "version"]],
  postal_provider_connections: [["legalEntityId", "provider", "environment"]],
  postal_evidence: [["dispatchId", "kind"]],
};

/** Tables sans colonne legal_entity_id obligatoire (filtrées par tenant seulement). */
export const NULLABLE_ENTITY: Table[] = ["postal_audit_logs", "postal_organizations", "postal_webhook_receipts"];

// EN CLAIR : Teste si une ligne correspond aux critères de recherche.
export function matches(row: Record<string, unknown>, where: Where): boolean {
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c && !(c.in as unknown[]).includes(v)) return false;
      if ("lte" in c && !(v !== null && v !== undefined && (v as string) <= (c.lte as string))) return false;
      if ("lt" in c && !(v !== null && v !== undefined && (v as string) < (c.lt as string))) return false;
      if ("gte" in c && !(v !== null && v !== undefined && (v as string) >= (c.gte as string))) return false;
      if ("isNull" in c && (v === null || v === undefined) !== c.isNull) return false;
      if ("ne" in c && v === c.ne) return false;
    } else if (v !== cond && !(cond === null && v === undefined)) return false;
  }
  return true;
}

// EN CLAIR : Refuse d'écrire une ligne qui appartient à une autre société.
export function assertRowInScope(scope: Scope, table: Table, row: Record<string, unknown>): void {
  if (scope.tenantId !== "*" && row.tenantId !== scope.tenantId) throw new PostalError("FORBIDDEN", "Écriture hors tenant");
  if (scope.legalEntityIds === "*") return;
  const le = row.legalEntityId as string | null | undefined;
  if ((le === null || le === undefined) && NULLABLE_ENTITY.includes(table)) return;
  if (!le || !scope.legalEntityIds.includes(le)) throw new PostalError("FORBIDDEN", "Écriture hors entité juridique autorisée");
}

// EN CLAIR : Masque les lignes des autres sociétés.
export function scopeFilter(scope: Scope, table: Table, row: Record<string, unknown>): boolean {
  if (scope.tenantId !== "*" && row.tenantId !== scope.tenantId) return false;
  if (scope.legalEntityIds === "*") return true;
  const le = row.legalEntityId as string | null | undefined;
  if (le === null || le === undefined) return NULLABLE_ENTITY.includes(table);
  return scope.legalEntityIds.includes(le);
}

// ------------------------------------------------------------ Base mémoire

type Store = Map<Table, Record<string, unknown>[]>;

export class MemoryDb implements Db {
  constructor(
    readonly scope: Scope,
    private readonly store: Store = new Map(),
  ) {}

  withScope(scope: Scope): Db {
    return new MemoryDb(scope, this.store);
  }

  private rows(t: Table) {
    let r = this.store.get(t);
    if (!r) {
      r = [];
      this.store.set(t, r);
    }
    return r;
  }

  private violates(t: Table, row: Record<string, unknown>): boolean {
    for (const cols of UNIQUES[t] ?? []) {
      if (this.rows(t).some((r) => cols.every((c) => r[c] === row[c] && row[c] !== null && row[c] !== undefined))) return true;
    }
    return false;
  }

  async insert<T extends object>(t: Table, row: T): Promise<T> {
    const r = structuredClone(row) as Record<string, unknown>;
    assertRowInScope(this.scope, t, r);
    if (this.violates(t, r)) throw new PostalError("CONFLICT", `Doublon sur ${t}`);
    if (this.rows(t).some((x) => x.id === r.id)) throw new PostalError("CONFLICT", `Doublon d'id sur ${t}`);
    this.rows(t).push(r);
    return structuredClone(r) as T;
  }

  async insertIgnore<T extends object>(t: Table, row: T): Promise<boolean> {
    try {
      await this.insert(t, row);
      return true;
    } catch (e) {
      if (e instanceof PostalError && e.code === "CONFLICT") return false;
      throw e;
    }
  }

  async update(t: Table, where: Where, patch: Record<string, unknown>): Promise<number> {
    let n = 0;
    for (const r of this.rows(t)) {
      if (scopeFilter(this.scope, t, r) && matches(r, where)) {
        Object.assign(r, structuredClone(patch));
        n++;
      }
    }
    return n;
  }

  async find<T>(t: Table, where: Where = {}, opts: FindOpts = {}): Promise<T[]> {
    let res = this.rows(t).filter((r) => scopeFilter(this.scope, t, r) && matches(r, where));
    for (const [col, dir] of (opts.orderBy ?? []).toReversed()) {
      res = res.toSorted((a, b) => {
        const av = a[col] as string | number;
        const bv = b[col] as string | number;
        const c = av === bv ? 0 : av === null || av === undefined ? -1 : bv === null || bv === undefined ? 1 : av < bv ? -1 : 1;
        return dir === "asc" ? c : -c;
      });
    }
    if (opts.offset) res = res.slice(opts.offset);
    if (opts.limit !== undefined) res = res.slice(0, opts.limit);
    return structuredClone(res) as T[];
  }

  async one<T>(t: Table, where: Where): Promise<T | null> {
    return (await this.find<T>(t, where, { limit: 1 }))[0] ?? null;
  }

  async count(t: Table, where: Where = {}) {
    return (await this.find(t, where)).length;
  }

  async sum(t: Table, column: string, where: Where = {}) {
    return (await this.find<Record<string, number | null>>(t, where)).reduce((s, r) => s + (r[column] ?? 0), 0);
  }

  async tx<R>(fn: (db: Db) => Promise<R>): Promise<R> {
    // Transaction mémoire : instantané + restauration en cas d'erreur.
    const snapshot = new Map([...this.store.entries()].map(([k, v]) => [k, structuredClone(v)]));
    try {
      return await fn(this);
    } catch (e) {
      this.store.clear();
      for (const [k, v] of snapshot) this.store.set(k, v);
      throw e;
    }
  }

  async claimOutbox(nowIso: string, limit: number, lockMs: number) {
    const due = this.rows("postal_outbox")
      .filter((r) => scopeFilter(this.scope, "postal_outbox", r))
      .filter((r) => (r.status === "pending" || (r.status === "processing" && (r.lockedUntil as string) < nowIso)) && (r.nextRetryAt as string) <= nowIso)
      .toSorted((a, b) => String(a.nextRetryAt).localeCompare(String(b.nextRetryAt)))
      .slice(0, limit);
    const until = new Date(Date.parse(nowIso) + lockMs).toISOString();
    for (const r of due) Object.assign(r, { status: "processing", lockedUntil: until });
    return structuredClone(due);
  }
}

export const systemScope = (tenantId: string | "*" = "*"): Scope => ({ tenantId, legalEntityIds: "*", centerIds: "*", userId: null });
