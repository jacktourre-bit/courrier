import type { Dispatch, RetentionPolicy, Scope } from "../domain/types.js";
import { TERMINAL } from "../domain/state-machine.js";
import { uuid } from "../lib/util.js";
import { audit, nowIso, requireEntity, requirePermission, type Asset, type Ctx, type Deps } from "./context.js";

/**
 * Durées de conservation (§13.3) : aucune durée unique n'est imposée par le code.
 * Sans politique explicite, rien n'est purgé. Une purge supprime le contenu
 * chiffré et conserve la ligne d'actif (type, date, SHA-256) comme trace.
 */
export async function setRetentionPolicy(ctx: Ctx, p: { legalEntityId: string; assetKind: string; retainDays: number; legalBasis: string }): Promise<RetentionPolicy> {
  requirePermission(ctx, "postal.retention.manage");
  requireEntity(ctx, p.legalEntityId);
  const row: RetentionPolicy = { ...p, id: uuid(), tenantId: ctx.scope.tenantId, createdBy: ctx.scope.userId!, createdAt: nowIso(ctx) };
  await ctx.db.insert("postal_retention_policies", row);
  await audit(ctx, { legalEntityId: p.legalEntityId, action: "retention.policy_set", objectType: "retention_policy", objectId: row.id, metadata: { assetKind: p.assetKind, retainDays: p.retainDays, legalBasis: p.legalBasis } });
  return row;
}

/** Références d'un actif par un envoi encore actif : jamais purgé tant que l'envoi n'est pas terminé. */
async function inUse(ctx: Deps & { scope: Scope }, asset: Asset): Promise<boolean> {
  const refs = [
    ...(await ctx.db.find<Dispatch>("postal_dispatches", { documentAssetId: asset.id })),
    ...(await ctx.db.find<Dispatch>("postal_dispatches", { previewAssetId: asset.id })),
  ];
  const viaAttachment = await ctx.db.find<{ dispatchId: string }>("postal_attachments", { assetId: asset.id });
  for (const a of viaAttachment) {
    const d = await ctx.db.one<Dispatch>("postal_dispatches", { id: a.dispatchId });
    if (d) refs.push(d);
  }
  const sensitive = (await ctx.db.find<Dispatch>("postal_dispatches", { legalEntityId: asset.legalEntityId })).filter((d) => (d.optionsJson as { sensitiveValuesAssetId?: string }).sensitiveValuesAssetId === asset.id);
  return [...refs, ...sensitive].some((d) => !TERMINAL.includes(d.status) && d.status !== "REJECTED" && d.status !== "FAILED_VALIDATION" && d.status !== "FAILED_PROVIDER");
}

export async function runRetentionPurge(deps: Deps): Promise<{ purged: number; skippedInUse: number }> {
  const sys = deps.db.withScope({ tenantId: "*", legalEntityIds: "*", centerIds: "*", userId: null });
  const policies = await sys.find<RetentionPolicy>("postal_retention_policies", {});
  let purged = 0;
  let skippedInUse = 0;
  for (const p of policies) {
    const scope: Scope = { tenantId: p.tenantId, legalEntityIds: [p.legalEntityId], centerIds: "*", userId: null };
    const ctx = { ...deps, scope, db: deps.db.withScope(scope) };
    const limit = new Date(deps.clock.now().getTime() - p.retainDays * 86_400_000).toISOString();
    const assets = await ctx.db.find<Asset>("postal_assets", { legalEntityId: p.legalEntityId, kind: p.assetKind, purgedAt: { isNull: true }, createdAt: { lt: limit } });
    for (const a of assets) {
      if (await inUse(ctx, a)) {
        skippedInUse++;
        continue;
      }
      await deps.blobs.delete(a.storageKey);
      await ctx.db.update("postal_assets", { id: a.id }, { purgedAt: nowIso(deps) });
      await audit(ctx, { legalEntityId: a.legalEntityId, action: "retention.asset_purged", objectType: "asset", objectId: a.id, metadata: { kind: a.kind, sha256: a.sha256, policyId: p.id } });
      purged++;
    }
  }
  return { purged, skippedInUse };
}
