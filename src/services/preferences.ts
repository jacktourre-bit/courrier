import type { CampaignRecipient, ContactPreference, Dispatch, SubjectType } from "../domain/types.js";
import { IN_FLIGHT, PRE_SUBMISSION } from "../domain/state-machine.js";
import { uuid } from "../lib/util.js";
import { audit, nowIso, requireEntity, requirePermission, type Ctx } from "./context.js";
import { enqueue, transition } from "./dispatch-service.js";

/**
 * Enregistre une préférence postale (par société, par finalité). Une opposition :
 *  - annule les envois non encore transmis de cette finalité ;
 *  - demande le blocage côté Manuscry pour les envois déjà transmis (arrêt des occurrences futures) ;
 *  - neutralise les inscriptions de campagne futures.
 */
export async function setPreference(
  ctx: Ctx,
  p: { legalEntityId: string; subjectType: SubjectType; subjectId: string; purpose: ContactPreference["purpose"]; allowed: boolean; legalBasis?: string | null; evidenceId?: string | null; source: string },
): Promise<ContactPreference> {
  requirePermission(ctx, "postal.draft");
  requireEntity(ctx, p.legalEntityId);
  const pref: ContactPreference = {
    id: uuid(),
    tenantId: ctx.scope.tenantId,
    legalEntityId: p.legalEntityId,
    subjectType: p.subjectType,
    subjectId: p.subjectId,
    purpose: p.purpose,
    channel: "postal",
    allowed: p.allowed,
    legalBasis: p.legalBasis ?? null,
    evidenceId: p.evidenceId ?? null,
    source: p.source.slice(0, 80),
    updatedAt: nowIso(ctx),
  };
  // Historique conservé : on insère, la plus récente fait foi.
  await ctx.db.insert("postal_contact_preferences", pref);
  await audit(ctx, { legalEntityId: p.legalEntityId, action: p.allowed ? "preference.granted" : "preference.opposed", objectType: p.subjectType, objectId: p.subjectId, metadata: { purpose: p.purpose, source: p.source } });

  if (!p.allowed) {
    const purposes = p.purpose === "birthday" ? ["relationship"] : [p.purpose];
    const ds = await ctx.db.find<Dispatch>("postal_dispatches", { legalEntityId: p.legalEntityId, subjectType: p.subjectType, subjectId: p.subjectId, purpose: { in: purposes } });
    for (const d of ds) {
      if (p.purpose === "birthday" && !(d.eventKey ?? "").startsWith("birthday:")) continue;
      if (PRE_SUBMISSION.includes(d.status)) {
        await ctx.db.update("postal_outbox", { dispatchId: d.id, status: { in: ["pending", "processing"] } }, { status: "done", lastError: "opposition" });
        await transition(ctx, d, "CANCELLED", { incident: "Annulé suite à opposition" });
      } else if (d.provider === "manuscry" && (IN_FLIGHT.includes(d.status) || d.status === "DELIVERED")) {
        await enqueue(ctx, d, "PROVIDER_BLOCK", { reason: "opposition" }, nowIso(ctx));
      }
    }
    const recips = await ctx.db.find<CampaignRecipient>("postal_campaign_recipients", { subjectType: p.subjectType, subjectId: p.subjectId, outcome: "queued", legalEntityId: p.legalEntityId });
    for (const r of recips) await ctx.db.update("postal_campaign_recipients", { id: r.id }, { outcome: "skipped", reason: "opposition" });
  }
  return pref;
}
