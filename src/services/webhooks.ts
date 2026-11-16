/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Réception des notifications (« webhooks ») envoyées par les prestataires. L'adresse de
 * réception contient un code secret propre à chaque connexion. Chaque notification est
 * conservée chiffrée comme trace, les doublons sont ignorés, et on n'en croit jamais le
 * contenu : elle déclenche seulement une vérification de l'état réel via l'API. Un faux
 * message ne peut donc rien modifier.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { Dispatch, ProviderConnection, ProviderName, Scope } from "../domain/types.js";
import { sha256, safeEqual, uuid } from "../lib/util.js";
import { nowIso, providerEnabled, storeAsset, type Deps } from "./context.js";
import { enqueue } from "./dispatch-service.js";

/**
 * Réception des webhooks (§7, §8.4, §10). Aucun des deux prestataires ne
 * documente de signature : la compensation retenue est
 *   1. jeton secret long et unique par connexion, dans l'URL (comparé en temps constant, stocké haché) ;
 *   2. taille bornée, JSON validé, déduplication (at-least-once) ;
 *   3. AUCUN statut n'est lu depuis le payload : on déclenche un rapprochement via l'API.
 * Un webhook forgé ne peut donc, au pire, que provoquer une relecture de l'état réel.
 */
export interface WebhookOutcome {
  httpStatus: number;
  result: "accepted" | "duplicate" | "ignored" | "unmatched" | "rejected";
}

export interface WebhookReceipt {
  id: string;
  tenantId: string;
  legalEntityId: string | null;
  provider: ProviderName;
  dedupKey: string;
  eventType: string;
  payloadDigest: string;
  dispatchId: string | null;
  result: WebhookOutcome["result"];
  receivedAt: string;
  /** Contenu brut chiffré (preuve de réception de la notification), null si doublon/ignoré. */
  payloadAssetId: string | null;
}

export const MAX_WEBHOOK_BYTES = 64 * 1024;

// EN CLAIR : Reçoit une notification : vérifie le code secret, ignore les doublons, garde une copie
// chiffrée, retrouve le courrier, lance la vérification.
export async function ingestWebhook(deps: Deps, provider: ProviderName, token: string, rawBody: string): Promise<WebhookOutcome> {
  if (!deps.config.flags.POSTAL_MODULE_ENABLED || !providerEnabled(deps, provider)) return { httpStatus: 404, result: "rejected" };
  if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES || token.length < 32) return { httpStatus: 404, result: "rejected" };

  const sys = deps.db.withScope({ tenantId: "*", legalEntityIds: "*", centerIds: "*", userId: null });
  const tokenHash = sha256(token);
  const conns = await sys.find<ProviderConnection>("postal_provider_connections", { provider, status: "active" });
  const conn = conns.find((c) => c.webhookTokenHash && safeEqual(c.webhookTokenHash, tokenHash));
  // Réponse identique à une route inexistante : on ne révèle pas l'existence du jeton.
  if (!conn) return { httpStatus: 404, result: "rejected" };

  const adapter = deps.adapters[provider];
  if (!adapter) return { httpStatus: 404, result: "rejected" };
  const parsed = adapter.handleWebhook(rawBody, {});
  const scope: Scope = { tenantId: conn.tenantId, legalEntityIds: [conn.legalEntityId], centerIds: "*", userId: null };
  const db = deps.db.withScope(scope);
  const ctx = { ...deps, scope, db };
  const at = nowIso(deps);

  if (!parsed.ok) {
    deps.logger.warn("webhook.unparseable", { provider, reason: parsed.message });
    return { httpStatus: 400, result: "rejected" };
  }
  const w = parsed.value;
  const receipt: WebhookReceipt = {
    id: uuid(),
    tenantId: conn.tenantId,
    legalEntityId: conn.legalEntityId,
    provider,
    dedupKey: w.dedupKey,
    eventType: w.eventType.slice(0, 80),
    payloadDigest: w.payloadDigest,
    dispatchId: null,
    result: "accepted",
    receivedAt: at,
    payloadAssetId: null,
  };

  if (w.ignore) {
    const fresh = await db.insertIgnore("postal_webhook_receipts", { ...receipt, result: "ignored" });
    return { httpStatus: 200, result: fresh ? "ignored" : "duplicate" };
  }

  // Envoi concerné, strictement dans le périmètre de la connexion
  let d: Dispatch | null = null;
  if (w.lookup.uid) d = await db.one<Dispatch>("postal_dispatches", { provider, providerUid: w.lookup.uid });
  if (!d && w.lookup.identifier) d = await db.one<Dispatch>("postal_dispatches", { provider, reference: w.lookup.identifier });
  if (!d && w.lookup.letterId) d = await db.one<Dispatch>("postal_dispatches", { provider, providerLetterId: w.lookup.letterId });

  const known = await db.one<WebhookReceipt>("postal_webhook_receipts", { provider, dedupKey: w.dedupKey });
  if (known) return { httpStatus: 200, result: "duplicate" };
  // Contenu brut conservé chiffré (il contient des données personnelles) : preuve de la notification reçue.
  const asset = await storeAsset(ctx, { tenantId: conn.tenantId, legalEntityId: conn.legalEntityId, bytes: new TextEncoder().encode(rawBody), mimeType: "application/json", sensitivity: d?.sensitivity ?? "personal_non_health", kind: "webhook_payload", retentionPolicy: "probatoire_a_definir" });
  const fresh = await db.insertIgnore("postal_webhook_receipts", { ...receipt, dispatchId: d?.id ?? null, result: d ? "accepted" : "unmatched", payloadAssetId: asset.id });
  if (!fresh) return { httpStatus: 200, result: "duplicate" };
  if (!d) {
    deps.logger.warn("webhook.unmatched", { provider, eventType: w.eventType });
    return { httpStatus: 200, result: "unmatched" };
  }
  // Rapprochement immédiat (le payload n'est qu'un signal).
  const pending = await db.one("postal_outbox", { dispatchId: d.id, action: "RECONCILE", status: "pending", nextRetryAt: { lte: at } });
  if (!pending) await enqueue(ctx, d, "RECONCILE", { reason: `webhook:${receipt.eventType}` }, at);
  return { httpStatus: 200, result: "accepted" };
}
