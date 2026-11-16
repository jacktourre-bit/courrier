import type { Dispatch, Evidence, EvidenceKind, OutboxItem, PostalEvent, ProviderConnection, Scope } from "../domain/types.js";
import { applyProviderStatus, TERMINAL } from "../domain/state-machine.js";
import type { ProviderResult, StatusResult } from "../providers/types.js";
import { PostalError } from "../lib/errors.js";
import { parisDate, sha256, uuid } from "../lib/util.js";
import { audit, nowIso, openTask, resolveConnection, storeAsset, type Deps } from "./context.js";
import { buildSubmissionForWorker, computeApprovalHash, contentMatchesApproval, enqueue, evidenceExpected, internalEvent, recheckCompliance, scheduleInstant, transition } from "./dispatch-service.js";

/**
 * Worker transactionnel de l'outbox (§9-10). Règles :
 *  - jamais de relance aveugle d'une création : un échec ambigu => UNKNOWN_SUBMISSION_STATUS + rapprochement ;
 *  - retries uniquement si la non-création est certaine ; 429 => Retry-After ;
 *  - 4xx définitifs => tâche humaine ; dépassement des tentatives => dead-letter.
 */
type WCtx = Deps & { scope: Scope };

const RECONCILE_FALLBACK_HOURS = 24;
const MAX_RECONCILES = 21;

export function backoffMs(attempt: number): number {
  return Math.min(6 * 3_600_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}

export async function runOutboxOnce(deps: Deps, limit = 20): Promise<{ processed: number }> {
  const sys = deps.db.withScope({ tenantId: "*", legalEntityIds: "*", centerIds: "*", userId: null });
  const items = (await sys.claimOutbox(nowIso(deps), limit, 5 * 60_000)) as unknown as OutboxItem[];
  for (const it of items) {
    const scope: Scope = { tenantId: it.tenantId, legalEntityIds: [it.legalEntityId], centerIds: "*", userId: null };
    const ctx: WCtx = { ...deps, scope, db: deps.db.withScope(scope) };
    try {
      await processItem(ctx, it);
    } catch (e) {
      await failItem(ctx, it, e instanceof Error ? e.message : String(e), "retry");
      deps.logger.error("outbox.item_failed", { id: it.id, action: it.action, error: e instanceof PostalError ? e.code : "exception" });
    }
  }
  return { processed: items.length };
}

async function done(ctx: WCtx, it: OutboxItem, note: string | null = null) {
  await ctx.db.update("postal_outbox", { id: it.id }, { status: "done", lockedUntil: null, lastError: note, attempts: it.attempts + 1 });
}

async function failItem(ctx: WCtx, it: OutboxItem, err: string, mode: "retry" | "human" | "retry_after", retryAfterMs?: number) {
  const attempts = it.attempts + 1;
  if (mode === "human" || attempts >= ctx.config.outboxMaxAttempts) {
    await ctx.db.update("postal_outbox", { id: it.id }, { status: mode === "human" ? "human_task" : "dead", attempts, lastError: err.slice(0, 300), lockedUntil: null });
    await openTask(ctx, { id: it.dispatchId, tenantId: it.tenantId, legalEntityId: it.legalEntityId }, `outbox_${it.action.toLowerCase()}`, err);
    return;
  }
  const delay = mode === "retry_after" && retryAfterMs !== undefined ? retryAfterMs : backoffMs(attempts);
  await ctx.db.update("postal_outbox", { id: it.id }, { status: "pending", attempts, lastError: err.slice(0, 300), lockedUntil: null, nextRetryAt: new Date(ctx.clock.now().getTime() + delay).toISOString() });
}

async function reschedule(ctx: WCtx, it: OutboxItem, at: string) {
  await ctx.db.update("postal_outbox", { id: it.id }, { status: "pending", lockedUntil: null, nextRetryAt: at });
}

async function loadDispatch(ctx: WCtx, id: string): Promise<Dispatch> {
  const d = await ctx.db.one<Dispatch>("postal_dispatches", { id });
  if (!d) throw new PostalError("NOT_FOUND", "Envoi introuvable");
  return d;
}

async function processItem(ctx: WCtx, it: OutboxItem) {
  switch (it.action) {
    case "SUBMIT":
      return submitItem(ctx, it);
    case "RECONCILE":
      return reconcileItem(ctx, it);
    case "FETCH_EVIDENCE":
      return evidenceItem(ctx, it);
    case "CANCEL":
      return cancelItem(ctx, it);
    case "PROVIDER_VALIDATE":
      return providerValidateItem(ctx, it);
    case "PROVIDER_BLOCK":
      return blockItem(ctx, it);
  }
}

// ----------------------------------------------------------------- SUBMIT

async function submitItem(ctx: WCtx, it: OutboxItem) {
  let d = await loadDispatch(ctx, it.dispatchId);
  if (d.status !== "APPROVED" && d.status !== "SCHEDULED") return done(ctx, it, `ignoré : statut ${d.status}`);
  if (d.scheduledFor && d.scheduledFor > parisDate(ctx.clock.now())) return reschedule(ctx, it, scheduleInstant(d.scheduledFor));

  // Reprise après crash : une tentative a déjà été émise, on ne renvoie pas à l'aveugle.
  if (d.submissionAttemptedAt) {
    d = await transition(ctx, d, "UNKNOWN_SUBMISSION_STATUS", { incident: "Reprise après interruption : soumission à rapprocher" });
    await enqueue(ctx, d, "RECONCILE", { reason: "resume" }, nowIso(ctx));
    return done(ctx, it, "rapprochement requis");
  }

  // Contrôles de dernière minute : opposition, décès, document modifié…
  const blockers = await recheckCompliance(ctx, d);
  if (blockers.length) {
    await transition(ctx, d, "FAILED_VALIDATION", { incident: blockers.map((b) => b.message).join(" ; ").slice(0, 300) });
    await audit(ctx, { legalEntityId: d.legalEntityId, action: "dispatch.blocked_before_submit", objectType: "dispatch", objectId: d.id, metadata: { codes: blockers.map((b) => b.code) } });
    return done(ctx, it, "bloqué par la conformité");
  }
  if (!contentMatchesApproval(await computeApprovalHash(ctx, d), d.approvalHash)) {
    await transition(ctx, d, "FAILED_VALIDATION", { incident: "Contenu différent de la version approuvée" });
    return done(ctx, it, "hash d'approbation divergent");
  }

  const { conn, adapter } = await resolveConnection(ctx, d.legalEntityId, d.provider);
  const req = await buildSubmissionForWorker(ctx, d);
  // Marqueur posé AVANT l'appel : protège contre un double envoi en cas de crash.
  const marked = await ctx.db.update("postal_dispatches", { id: d.id, rowVersion: d.rowVersion }, { submissionAttemptedAt: nowIso(ctx), rowVersion: d.rowVersion + 1 });
  if (marked !== 1) return reschedule(ctx, it, nowIso(ctx));
  d = { ...d, submissionAttemptedAt: nowIso(ctx), rowVersion: d.rowVersion + 1 };

  const r = await adapter.submit(conn, req, { uid: d.providerUid, identifier: d.reference, campaignId: d.providerCampaignId });
  if (r.ok) {
    d = await transition(ctx, d, "SUBMITTED", {
      submittedAt: nowIso(ctx),
      providerUid: r.value.ref.uid ?? d.providerUid,
      rawProviderStatus: r.value.rawStatus,
      lastSyncedAt: nowIso(ctx),
      incident: r.value.rawStatus === "contact_added_with_warnings" ? "Avertissement prestataire : adresse à vérifier dans Manuscry" : d.incident,
    });
    await audit(ctx, { legalEntityId: d.legalEntityId, action: "dispatch.submitted", objectType: "dispatch", objectId: d.id, metadata: { provider: d.provider } });
    await enqueue(ctx, d, "RECONCILE", { n: 1 }, new Date(ctx.clock.now().getTime() + (d.provider === "servicepostal" ? 2 : RECONCILE_FALLBACK_HOURS) * 3_600_000).toISOString());
    return done(ctx, it);
  }
  return handleSubmitFailure(ctx, it, d, r);
}

async function handleSubmitFailure(ctx: WCtx, it: OutboxItem, d: Dispatch, r: Extract<ProviderResult<unknown>, { ok: false }>) {
  switch (r.kind) {
    case "UNKNOWN": {
      const next = await transition(ctx, d, "UNKNOWN_SUBMISSION_STATUS", { incident: `Issue inconnue : ${r.message}` });
      await enqueue(ctx, next, "RECONCILE", { reason: "unknown_submission" }, new Date(ctx.clock.now().getTime() + 5 * 60_000).toISOString());
      return done(ctx, it, "UNKNOWN_SUBMISSION_STATUS");
    }
    case "RETRYABLE":
    case "RATE_LIMITED":
      // Non-création certaine : on lève le marqueur et on réessaie plus tard.
      await ctx.db.update("postal_dispatches", { id: d.id }, { submissionAttemptedAt: null, rowVersion: d.rowVersion + 1 });
      return failItem(ctx, it, r.message, r.kind === "RATE_LIMITED" ? "retry_after" : "retry", r.retryAfterMs);
    case "INSUFFICIENT_FUNDS":
      await transition(ctx, d, "INSUFFICIENT_FUNDS", { incident: "Crédits insuffisants chez le prestataire", submissionAttemptedAt: null });
      return failItem(ctx, it, r.message, "human");
    default: {
      // AUTH (401), CAMPAIGN_INACTIVE (403), DEFINITIVE (4xx), UNSUPPORTED : tâche humaine.
      const label = r.kind === "AUTH" ? "Clé API invalide" : r.kind === "CAMPAIGN_INACTIVE" ? "Campagne suspendue ou annulée" : r.message;
      await transition(ctx, d, "FAILED_PROVIDER", { incident: `${label}${r.fields?.length ? ` (champs : ${r.fields.join(", ")})` : ""}`.slice(0, 300), submissionAttemptedAt: null });
      return failItem(ctx, it, `${r.kind}: ${r.message}`, "human");
    }
  }
}

// -------------------------------------------------------------- RECONCILE

export async function reconcileDispatch(ctx: WCtx, d: Dispatch): Promise<{ dispatch: Dispatch; status: ProviderResult<StatusResult> }> {
  const { conn, adapter } = await resolveConnection(ctx, d.legalEntityId, d.provider);
  const st = await adapter.getStatus(conn, { uid: d.providerUid, identifier: d.reference, letterId: d.providerLetterId, leadId: d.providerLeadId, campaignId: d.providerCampaignId });
  if (!st.ok) return { dispatch: d, status: st };
  const s = st.value;
  const at = nowIso(ctx);

  // Identifiants découverts (lettre/lead Manuscry)
  const ids: Partial<Dispatch> = {};
  if (s.ref.letterId && s.ref.letterId !== d.providerLetterId) ids.providerLetterId = s.ref.letterId;
  if (s.ref.leadId && s.ref.leadId !== d.providerLeadId) ids.providerLeadId = s.ref.leadId;
  if (s.trackingNumber && s.trackingNumber !== d.trackingNumber) ids.trackingNumber = s.trackingNumber;

  // Événements bruts, dédupliqués
  for (const e of s.events) {
    await ctx.db.insertIgnore<PostalEvent>("postal_events", {
      id: uuid(),
      tenantId: d.tenantId,
      legalEntityId: d.legalEntityId,
      dispatchId: d.id,
      provider: d.provider,
      providerEventId: e.eventId,
      eventType: e.eventType,
      rawStatus: e.rawStatus,
      mappedStatus: e.mappedStatus,
      occurredAt: e.occurredAt,
      receivedAt: at,
      payloadDigest: sha256(`${e.eventId}`),
    });
  }

  let next = d;
  if (d.status === "UNKNOWN_SUBMISSION_STATUS") {
    if (d.provider === "servicepostal" && s.rawStatus === "previsualise") {
      // Certitude : la validation n'a pas été prise en compte -> on peut resoumettre.
      next = await transition(ctx, d, "APPROVED", { ...ids, submissionAttemptedAt: null, incident: "Validation non prise en compte : resoumission", lastSyncedAt: at, rawProviderStatus: s.rawStatus });
      await enqueue(ctx, next, "SUBMIT", { reason: "reconciled_not_created" }, at);
      return { dispatch: next, status: st };
    }
    if (s.rawStatus === "not_found" || !s.mappedStatus) {
      // Absence non prouvée (Manuscry) : décision humaine, jamais de renvoi automatique.
      await ctx.db.update("postal_dispatches", { id: d.id }, { ...ids, lastSyncedAt: at, rawProviderStatus: s.rawStatus, rowVersion: d.rowVersion + 1 });
      await openTask(ctx, d, "unknown_submission", "Soumission non retrouvée chez le prestataire : vérifier dans son interface avant toute nouvelle tentative");
      return { dispatch: { ...d, ...ids, rowVersion: d.rowVersion + 1 }, status: st };
    }
    next = await transition(ctx, d, s.mappedStatus, {
      ...ids,
      submittedAt: d.submittedAt ?? at,
      lastSyncedAt: at,
      rawProviderStatus: s.rawStatus,
      incident: null,
    });
  } else {
    const decision = applyProviderStatus(d.status, s.mappedStatus);
    const patch: Partial<Dispatch> = { ...ids, lastSyncedAt: at, rawProviderStatus: s.rawStatus };
    if (decision.next) {
      if (decision.next === "DELIVERED") patch.deliveredAt = at;
      if (decision.next === "CANCELLED" && d.status !== "CANCEL_REQUESTED") patch.incident = "Annulé côté prestataire";
      next = await transition(ctx, d, decision.next, patch);
    } else {
      await ctx.db.update("postal_dispatches", { id: d.id, rowVersion: d.rowVersion }, { ...patch, rowVersion: d.rowVersion + 1 });
      next = { ...d, ...patch, rowVersion: d.rowVersion + 1 };
    }
  }

  if (s.awaitingProviderValidation) {
    const open = await ctx.db.one("postal_human_tasks", { dispatchId: d.id, kind: "provider_validation", status: "open" });
    if (!open) await openTask(ctx, d, "provider_validation", "Lettre générée à valider (fenêtre Manuscry de 60 min après validation)");
  }
  for (const kind of s.evidenceAvailable ?? []) await queueEvidence(ctx, next, kind);
  return { dispatch: next, status: st };
}

async function queueEvidence(ctx: WCtx, d: Dispatch, kind: EvidenceKind) {
  if (!evidenceExpected(d).includes(kind)) return;
  const have = await ctx.db.one<Evidence>("postal_evidence", { dispatchId: d.id, kind });
  const queued = await ctx.db.one("postal_outbox", { dispatchId: d.id, action: "FETCH_EVIDENCE", status: { in: ["pending", "processing"] }, payloadDigest: sha256(kind) });
  if (!have && !queued) {
    await ctx.db.insert<OutboxItem>("postal_outbox", {
      id: uuid(), tenantId: d.tenantId, legalEntityId: d.legalEntityId, dispatchId: d.id, action: "FETCH_EVIDENCE",
      payloadJson: { kind }, payloadDigest: sha256(kind), status: "pending", attempts: 0, nextRetryAt: nowIso(ctx), lastError: null, lockedUntil: null, createdAt: nowIso(ctx),
    });
  }
}

async function reconcileItem(ctx: WCtx, it: OutboxItem) {
  const d = await loadDispatch(ctx, it.dispatchId);
  if (TERMINAL.includes(d.status) && d.status !== "DELIVERED") return done(ctx, it, "terminal");
  const { dispatch, status } = await reconcileDispatch(ctx, d);
  if (!status.ok) {
    if (status.kind === "RATE_LIMITED") return failItem(ctx, it, status.message, "retry_after", status.retryAfterMs);
    if (status.kind === "AUTH") return failItem(ctx, it, status.message, "human");
    return failItem(ctx, it, status.message, "retry");
  }
  await done(ctx, it);
  // Consultation de secours espacée tant que l'envoi n'est pas terminé (pas de polling massif).
  const n = Number(it.payloadJson.n ?? 1);
  const missingEvidence =
    dispatch.status === "DELIVERED" && evidenceExpected(dispatch).includes("scanned_ar") && !(await ctx.db.one<Evidence>("postal_evidence", { dispatchId: dispatch.id, kind: "scanned_ar" }));
  if ((!TERMINAL.includes(dispatch.status) || missingEvidence) && dispatch.status !== "UNKNOWN_SUBMISSION_STATUS" && n < MAX_RECONCILES) {
    await enqueue(ctx, dispatch, "RECONCILE", { n: n + 1 }, new Date(ctx.clock.now().getTime() + RECONCILE_FALLBACK_HOURS * 3_600_000).toISOString());
  }
}

// ------------------------------------------------------------- EVIDENCE

async function evidenceItem(ctx: WCtx, it: OutboxItem) {
  const d = await loadDispatch(ctx, it.dispatchId);
  const kind = it.payloadJson.kind as EvidenceKind;
  if (await ctx.db.one<Evidence>("postal_evidence", { dispatchId: d.id, kind })) return done(ctx, it, "déjà obtenue");
  const { conn, adapter } = await resolveConnection(ctx, d.legalEntityId, d.provider);
  const r = await adapter.fetchEvidence(conn as ProviderConnection, { uid: d.providerUid, identifier: d.reference, letterId: d.providerLetterId }, kind);
  if (!r.ok) {
    if (r.kind === "NOT_AVAILABLE") return failItem(ctx, it, "preuve pas encore disponible", "retry_after", Math.max(backoffMs(it.attempts + 1), 3_600_000));
    if (r.kind === "UNSUPPORTED") return done(ctx, it, "non supporté");
    return failItem(ctx, it, r.message, r.kind === "DEFINITIVE" ? "human" : "retry");
  }
  const asset = await storeAsset(ctx, { tenantId: d.tenantId, legalEntityId: d.legalEntityId, bytes: r.value.bytes, mimeType: r.value.mimeType, sensitivity: d.sensitivity, kind: `evidence_${kind}`, retentionPolicy: "probatoire_a_definir" });
  await ctx.db.insertIgnore<Evidence>("postal_evidence", {
    id: uuid(), tenantId: d.tenantId, legalEntityId: d.legalEntityId, dispatchId: d.id, kind, securedAssetId: asset.id, sha256: asset.sha256,
    obtainedAt: nowIso(ctx), source: r.value.source, retentionPolicy: "probatoire_a_definir",
  });
  await internalEvent(ctx, d, `evidence:${kind}`, null);
  await audit(ctx, { legalEntityId: d.legalEntityId, action: "evidence.stored", objectType: "dispatch", objectId: d.id, metadata: { kind, sha256: asset.sha256 } });
  return done(ctx, it);
}

// --------------------------------------------------------------- CANCEL

async function cancelItem(ctx: WCtx, it: OutboxItem) {
  const d = await loadDispatch(ctx, it.dispatchId);
  if (d.status !== "CANCEL_REQUESTED") return done(ctx, it, `ignoré : ${d.status}`);
  const { conn, adapter } = await resolveConnection(ctx, d.legalEntityId, d.provider);
  const r = await adapter.cancel(conn, { uid: d.providerUid, identifier: d.reference, letterId: d.providerLetterId, leadId: d.providerLeadId, campaignId: d.providerCampaignId });
  if (!r.ok) {
    if (r.kind === "RETRYABLE" || r.kind === "RATE_LIMITED") return failItem(ctx, it, r.message, r.kind === "RATE_LIMITED" ? "retry_after" : "retry", r.retryAfterMs);
    await transition(ctx, d, d.statusBeforeCancel ?? "SUBMITTED", { incident: `Annulation refusée : ${r.message}`.slice(0, 300) });
    return failItem(ctx, it, r.message, "human");
  }
  if (r.value.cancelled) {
    // Statut « annulé » affiché uniquement après réponse effective du prestataire.
    await transition(ctx, d, "CANCELLED", { incident: null });
    await audit(ctx, { legalEntityId: d.legalEntityId, action: "dispatch.cancelled", objectType: "dispatch", objectId: d.id });
    return done(ctx, it);
  }
  await transition(ctx, d, d.statusBeforeCancel ?? "SUBMITTED", { incident: `Annulation refusée : ${r.value.message}`.slice(0, 300) });
  await openTask(ctx, d, "cancel_refused", "Annulation refusée par le prestataire (hors fenêtre). Contacter son support en urgence si nécessaire.");
  return done(ctx, it, "refus prestataire");
}

// ---------------------------------------------- Validation / blocage Manuscry

async function providerValidateItem(ctx: WCtx, it: OutboxItem) {
  const d = await loadDispatch(ctx, it.dispatchId);
  const { conn, adapter } = await resolveConnection(ctx, d.legalEntityId, d.provider);
  const decision = it.payloadJson.decision === "reject" ? "reject" : "validate";
  const r = await adapter.approve(conn, { letterId: d.providerLetterId }, decision);
  if (!r.ok) return failItem(ctx, it, r.message, r.kind === "RETRYABLE" || r.kind === "RATE_LIMITED" ? "retry" : "human", r.retryAfterMs);
  await internalEvent(ctx, d, `provider_${decision}`, null);
  await ctx.db.update("postal_human_tasks", { dispatchId: d.id, kind: "provider_validation", status: "open" }, { status: "closed", closedAt: nowIso(ctx), closedBy: String(it.payloadJson.userId ?? "system") });
  return done(ctx, it);
}

async function blockItem(ctx: WCtx, it: OutboxItem) {
  const d = await loadDispatch(ctx, it.dispatchId);
  const { conn, adapter } = await resolveConnection(ctx, d.legalEntityId, d.provider);
  const r = await adapter.block(conn, { identifier: d.reference, leadId: d.providerLeadId, campaignId: d.providerCampaignId });
  if (!r.ok) {
    if (r.kind === "NOT_AVAILABLE") return failItem(ctx, it, r.message, "retry_after", 3_600_000);
    return failItem(ctx, it, r.message, r.kind === "RETRYABLE" || r.kind === "RATE_LIMITED" ? "retry" : "human", r.retryAfterMs);
  }
  await internalEvent(ctx, d, "provider_blocked", null);
  await audit(ctx, { legalEntityId: d.legalEntityId, action: "provider.contact_blocked", objectType: "dispatch", objectId: d.id, metadata: { lettersCancelled: r.value.lettersCancelled } });
  return done(ctx, it);
}
