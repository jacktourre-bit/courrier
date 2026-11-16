/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Les outils communs aux services : vérifier les droits, écrire dans le journal d'audit,
 * ouvrir une tâche pour un humain, choisir la bonne connexion au prestataire, ranger et relire
 * un fichier.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { ModuleConfig } from "../config/flags.js";
import type { ProviderName, Scope, AuditEntry, ProviderConnection, Dispatch, Sensitivity } from "../domain/types.js";
import type { PostalProviderAdapter } from "../providers/types.js";
import type { Db } from "../store/db.js";
import type { BlobStore } from "../store/blobs.js";
import type { MalwareScanner } from "../lib/files.js";
import type { Logger } from "../lib/logger.js";
import { redact } from "../lib/logger.js";
import { PostalError } from "../lib/errors.js";
import { sha256, uuid, type Clock } from "../lib/util.js";

export interface Deps {
  db: Db;
  blobs: BlobStore;
  adapters: Partial<Record<ProviderName, PostalProviderAdapter>>;
  config: ModuleConfig;
  clock: Clock;
  logger: Logger;
  scanner: MalwareScanner;
  /** Injection pour tests (téléchargements d'aperçus/preuves). */
  fetchImpl?: typeof fetch;
  /** Tests uniquement : désactive le contrôle DNS anti-SSRF. */
  skipDnsCheck?: boolean;
}

/** Contexte d'appel : dépendances + périmètre de l'utilisateur ou du worker. */
export interface Ctx extends Deps {
  scope: Scope;
  permissions: Set<string>;
  /** Accès restreint par centre, le cas échéant. */
  db: Db;
}

export const nowIso = (c: Pick<Deps, "clock">) => c.clock.now().toISOString();

// EN CLAIR : Bloque si l'utilisateur n'a pas le droit demandé (ex. « postal.approve »).
export function requirePermission(ctx: Ctx, perm: string): void {
  if (!ctx.permissions.has(perm)) throw new PostalError("FORBIDDEN", `Permission requise : ${perm}`);
}

// EN CLAIR : Bloque si l'utilisateur travaille sur une société ou un centre qui n'est pas le sien.
export function requireEntity(ctx: Ctx, legalEntityId: string, centerId?: string | null): void {
  const s = ctx.scope;
  if (s.legalEntityIds !== "*" && !s.legalEntityIds.includes(legalEntityId)) throw new PostalError("FORBIDDEN", "Entité juridique non autorisée");
  if (centerId && s.centerIds && s.centerIds !== "*" && !s.centerIds.includes(centerId)) throw new PostalError("FORBIDDEN", "Centre non autorisé");
}

// EN CLAIR : Bloque tout si le module est éteint.
export function requireModule(ctx: Pick<Deps, "config">): void {
  if (!ctx.config.flags.POSTAL_MODULE_ENABLED) throw new PostalError("MODULE_DISABLED", "Module courriers désactivé");
}

export function providerEnabled(ctx: Pick<Deps, "config">, p: ProviderName): boolean {
  return p === "manuscry" ? ctx.config.flags.MANUSCRY_ENABLED : ctx.config.flags.SERVICEPOSTAL_ENABLED;
}

// EN CLAIR : Écrit une ligne dans le journal d'audit (qui a fait quoi, quand). Ce journal ne peut ni
// être modifié ni effacé.
export async function audit(ctx: Ctx | (Deps & { scope: Scope }), e: Omit<AuditEntry, "id" | "timestamp" | "tenantId" | "actorId" | "metadataRedacted"> & { tenantId?: string; metadata?: Record<string, unknown> }) {
  const tenantId = e.tenantId ?? ctx.scope.tenantId;
  await ctx.db.insert<AuditEntry>("postal_audit_logs", {
    id: uuid(),
    tenantId,
    legalEntityId: e.legalEntityId,
    actorId: ctx.scope.userId,
    action: e.action,
    objectType: e.objectType,
    objectId: e.objectId,
    timestamp: nowIso(ctx),
    metadataRedacted: redact(e.metadata ?? {}) as Record<string, unknown>,
  });
}

export interface HumanTask {
  id: string;
  tenantId: string;
  legalEntityId: string;
  dispatchId: string | null;
  kind: string;
  message: string;
  status: "open" | "closed";
  createdAt: string;
  closedAt: string | null;
  closedBy: string | null;
}

// EN CLAIR : Crée une tâche pour un humain (« vérifier ceci ») quand l'automate ne peut pas décider
// seul.
export async function openTask(ctx: Deps & { scope: Scope }, d: Pick<Dispatch, "tenantId" | "legalEntityId" | "id">, kind: string, message: string) {
  await ctx.db.insert<HumanTask>("postal_human_tasks", {
    id: uuid(),
    tenantId: d.tenantId,
    legalEntityId: d.legalEntityId,
    dispatchId: d.id,
    kind,
    message: message.slice(0, 300),
    status: "open",
    createdAt: nowIso(ctx),
    closedAt: null,
    closedBy: null,
  });
}

// EN CLAIR : Trouve la connexion au prestataire pour cette société, en refusant la production pendant
// les tests.
/** Connexion prestataire d'une entité, avec garde-fous flags + production. */
export async function resolveConnection(ctx: Deps & { scope: Scope }, legalEntityId: string, provider: ProviderName): Promise<{ conn: ProviderConnection; adapter: PostalProviderAdapter }> {
  if (!providerEnabled(ctx, provider)) throw new PostalError("PROVIDER_DISABLED", `Prestataire ${provider} désactivé`);
  const adapter = ctx.adapters[provider];
  if (!adapter) throw new PostalError("PROVIDER_DISABLED", `Adaptateur ${provider} absent`);
  const conns = await ctx.db.find<ProviderConnection>("postal_provider_connections", { legalEntityId, provider, status: "active" });
  const allowedProd = ctx.config.flags.POSTAL_PRODUCTION_PROVIDERS_ALLOWED;
  const conn = conns.find((c) => c.environment === "production" && allowedProd) ?? conns.find((c) => c.environment === "sandbox");
  if (!conn) throw new PostalError("PROVIDER_DISABLED", `Aucune connexion ${provider} utilisable pour cette entité`);
  return { conn, adapter };
}

export interface Asset {
  id: string;
  tenantId: string;
  legalEntityId: string;
  storageKey: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  sensitivity: Sensitivity;
  kind: string;
  retentionPolicy: string;
  createdBy: string | null;
  createdAt: string;
  purgedAt: string | null;
}

// EN CLAIR : Range un fichier chiffré et note son empreinte SHA-256.
export async function storeAsset(
  ctx: Deps & { scope: Scope },
  a: { tenantId: string; legalEntityId: string; bytes: Uint8Array; mimeType: string; sensitivity: Sensitivity; kind: string; retentionPolicy?: string },
): Promise<Asset> {
  const storageKey = await ctx.blobs.put(a.bytes);
  return ctx.db.insert<Asset>("postal_assets", {
    id: uuid(),
    tenantId: a.tenantId,
    legalEntityId: a.legalEntityId,
    storageKey,
    sha256: sha256(a.bytes),
    mimeType: a.mimeType,
    sizeBytes: a.bytes.byteLength,
    sensitivity: a.sensitivity,
    kind: a.kind,
    retentionPolicy: a.retentionPolicy ?? "to_define_by_dpo",
    createdBy: ctx.scope.userId,
    createdAt: nowIso(ctx),
    purgedAt: null,
  });
}

// EN CLAIR : Relit un fichier et vérifie que son empreinte n'a pas changé (sinon : alerte
// d'intégrité).
export async function readAsset(ctx: Deps & { scope: Scope }, assetId: string): Promise<{ asset: Asset; bytes: Uint8Array }> {
  const asset = await ctx.db.one<Asset>("postal_assets", { id: assetId });
  if (!asset) throw new PostalError("NOT_FOUND", "Pièce introuvable");
  if (asset.purgedAt) throw new PostalError("NOT_FOUND", "Pièce purgée (durée de conservation écoulée) ; empreinte SHA-256 conservée");
  const bytes = await ctx.blobs.get(asset.storageKey);
  if (sha256(bytes) !== asset.sha256) throw new PostalError("CONFLICT", "Intégrité de la pièce compromise");
  return { asset, bytes };
}

// EN CLAIR : Pour lire un document de santé, il faut une permission accordée nominativement.
/** Lecture d'un contenu sensible/santé : permission nominative obligatoire (P4). */
export function requireSensitiveRead(ctx: Ctx, sensitivity: Sensitivity): void {
  if ((sensitivity === "health" || sensitivity === "personal_sensitive") && !ctx.permissions.has("postal.sensitive.read")) {
    throw new PostalError("FORBIDDEN", "Contenu sensible : permission nominative postal.sensitive.read requise");
  }
}
