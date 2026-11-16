import type { DispatchStatus } from "./types.js";
import { PostalError } from "../lib/errors.js";

/**
 * Machine à états (cahier §10). Les transitions internes (actions utilisateur)
 * sont explicites ; les statuts remontés par les prestataires passent par
 * `applyProviderStatus`, qui ne fait jamais régresser un envoi (événements hors
 * ordre, webhooks rejoués).
 *
 * EVIDENCE_PENDING : conservé dans l'énumération pour compatibilité avec le
 * cahier, mais modélisé comme indicateur dérivé (preuves attendues vs obtenues)
 * et non comme étape du cycle de vie, pour ne pas masquer le statut DELIVERED.
 */
const T: Record<DispatchStatus, DispatchStatus[]> = {
  DRAFT: ["READY_FOR_PREVIEW", "FAILED_VALIDATION", "CANCELLED"],
  READY_FOR_PREVIEW: ["PREVIEWED", "FAILED_VALIDATION", "DRAFT", "CANCELLED"],
  PREVIEWED: ["PENDING_APPROVAL", "DRAFT", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "DRAFT", "CANCELLED"],
  APPROVED: ["SCHEDULED", "SUBMITTED", "UNKNOWN_SUBMISSION_STATUS", "FAILED_PROVIDER", "FAILED_VALIDATION", "INSUFFICIENT_FUNDS", "DRAFT", "CANCELLED"],
  SCHEDULED: ["APPROVED", "SUBMITTED", "UNKNOWN_SUBMISSION_STATUS", "FAILED_PROVIDER", "FAILED_VALIDATION", "INSUFFICIENT_FUNDS", "DRAFT", "CANCELLED"],
  SUBMITTED: ["IN_PRODUCTION", "POSTAL_DEPOSITED", "IN_TRANSIT", "DELIVERED", "RETURNED", "CANCEL_REQUESTED", "CANCELLED", "FAILED_PROVIDER", "INSUFFICIENT_FUNDS"],
  IN_PRODUCTION: ["POSTAL_DEPOSITED", "IN_TRANSIT", "DELIVERED", "RETURNED", "CANCEL_REQUESTED", "CANCELLED", "FAILED_PROVIDER"],
  POSTAL_DEPOSITED: ["IN_TRANSIT", "DELIVERED", "RETURNED"],
  IN_TRANSIT: ["DELIVERED", "RETURNED"],
  DELIVERED: [],
  RETURNED: [],
  REJECTED: ["DRAFT", "CANCELLED"],
  CANCEL_REQUESTED: ["CANCELLED", "SUBMITTED", "IN_PRODUCTION", "POSTAL_DEPOSITED", "IN_TRANSIT", "DELIVERED", "RETURNED"],
  CANCELLED: [],
  FAILED_VALIDATION: ["DRAFT", "CANCELLED"],
  FAILED_PROVIDER: ["APPROVED", "CANCELLED", "SUBMITTED"],
  INSUFFICIENT_FUNDS: ["APPROVED", "SUBMITTED", "IN_PRODUCTION", "CANCELLED", "FAILED_PROVIDER"],
  UNKNOWN_SUBMISSION_STATUS: ["SUBMITTED", "IN_PRODUCTION", "POSTAL_DEPOSITED", "IN_TRANSIT", "DELIVERED", "RETURNED", "APPROVED", "FAILED_PROVIDER", "INSUFFICIENT_FUNDS", "CANCELLED"],
  EVIDENCE_PENDING: [],
};

export const canTransition = (from: DispatchStatus, to: DispatchStatus): boolean => T[from].includes(to);

export function assertTransition(from: DispatchStatus, to: DispatchStatus): void {
  if (!canTransition(from, to)) throw new PostalError("INVALID_TRANSITION", `Transition interdite ${from} -> ${to}`, { from, to });
}

/** Rang de progression physique : sert à ignorer les événements en retard. */
const PROGRESS: Partial<Record<DispatchStatus, number>> = {
  SUBMITTED: 1,
  INSUFFICIENT_FUNDS: 1,
  IN_PRODUCTION: 2,
  POSTAL_DEPOSITED: 3,
  IN_TRANSIT: 4,
  DELIVERED: 5,
  RETURNED: 5,
};

export const TERMINAL: DispatchStatus[] = ["DELIVERED", "RETURNED", "CANCELLED"];
export const PRE_SUBMISSION: DispatchStatus[] = ["DRAFT", "READY_FOR_PREVIEW", "PREVIEWED", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "REJECTED", "FAILED_VALIDATION"];
export const IN_FLIGHT: DispatchStatus[] = ["SUBMITTED", "IN_PRODUCTION", "POSTAL_DEPOSITED", "IN_TRANSIT", "CANCEL_REQUESTED", "UNKNOWN_SUBMISSION_STATUS", "INSUFFICIENT_FUNDS"];
/** Statuts qui engagent une dépense (budget). */
export const COMMITTED: DispatchStatus[] = ["APPROVED", "SCHEDULED", "SUBMITTED", "IN_PRODUCTION", "POSTAL_DEPOSITED", "IN_TRANSIT", "DELIVERED", "RETURNED", "UNKNOWN_SUBMISSION_STATUS", "INSUFFICIENT_FUNDS", "CANCEL_REQUESTED"];

export interface ProviderStatusDecision {
  next: DispatchStatus | null;
  reason: "advanced" | "stale_or_equal" | "not_allowed" | "terminal" | "no_mapping";
}

/**
 * Applique un statut prestataire déjà traduit. Ne régresse jamais :
 * un `letter_sent` reçu après `letter_delivered` est enregistré mais sans effet.
 */
export function applyProviderStatus(current: DispatchStatus, mapped: DispatchStatus | null): ProviderStatusDecision {
  if (!mapped) return { next: null, reason: "no_mapping" };
  if (TERMINAL.includes(current)) return { next: null, reason: "terminal" };
  if (mapped === current) return { next: null, reason: "stale_or_equal" };
  if (mapped === "CANCELLED" || mapped === "FAILED_PROVIDER") {
    return canTransition(current, mapped) ? { next: mapped, reason: "advanced" } : { next: null, reason: "not_allowed" };
  }
  const cur = PROGRESS[current] ?? 0;
  const nxt = PROGRESS[mapped];
  if (nxt === undefined) return { next: null, reason: "no_mapping" };
  if (nxt <= cur) return { next: null, reason: "stale_or_equal" };
  return canTransition(current, mapped) ? { next: mapped, reason: "advanced" } : { next: null, reason: "not_allowed" };
}
