import type { DispatchStatus, EvidenceKind, PostageClass, PostalAddress, ProviderConnection, ProviderName } from "../domain/types.js";

/**
 * Résultat d'une opération prestataire. `kind` détermine la reprise :
 *  - RETRYABLE : la non-création est certaine, on peut réessayer ;
 *  - UNKNOWN : la requête a pu aboutir (timeout après émission) -> jamais de relance aveugle ;
 *  - DEFINITIVE / AUTH / CAMPAIGN_INACTIVE : tâche humaine ;
 *  - UNSUPPORTED : capacité non documentée chez ce prestataire ;
 *  - NOT_AVAILABLE : objet pas encore disponible (preuve, AR).
 */
export type FailureKind =
  | "UNSUPPORTED"
  | "NOT_AVAILABLE"
  | "RETRYABLE"
  | "UNKNOWN"
  | "DEFINITIVE"
  | "AUTH"
  | "RATE_LIMITED"
  | "INSUFFICIENT_FUNDS"
  | "CAMPAIGN_INACTIVE";

export type ProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: FailureKind; message: string; httpStatus?: number; retryAfterMs?: number; fields?: string[] };

export const ok = <T>(value: T): ProviderResult<T> => ({ ok: true, value });
export const unsupported = <T>(what: string): ProviderResult<T> => ({ ok: false, kind: "UNSUPPORTED", message: `${what} : non documenté chez ce prestataire` });

/** Identifiants externes connus d'un envoi. */
export interface ProviderRef {
  uid?: string | null;
  identifier?: string | null;
  letterId?: string | null;
  leadId?: string | null;
  campaignId?: string | null;
}

export interface DocumentPayload {
  bytes: Uint8Array;
  format: "pdf" | "docx";
}

/** Requête canonique interne transmise à un adaptateur, déjà minimisée. */
export interface SubmissionRequest {
  dispatchId: string;
  /** Identifiant opaque non médical (≤ 50 car. pour Service Postal). */
  reference: string;
  recipient: PostalAddress;
  sender: { businessName: string; address: PostalAddress };
  postageClass: PostageClass;
  options: { color?: "nb" | "couleur"; duplex?: "recto" | "rectoverso"; arScan?: boolean };
  document?: DocumentPayload;
  annexes?: DocumentPayload[];
  /** Manuscry : campagne et variables strictement issues des champs de campagne. */
  campaignId?: string;
  variables?: Record<string, string>;
  birthdayDate?: string;
  scheduledAt?: string | null;
  aiContext?: string | null;
  /** Service Postal : entité de facturation analytique (MAJUSCULES). */
  billingEntity?: string | null;
}

export interface PreviewResult {
  ref: ProviderRef;
  previewUrl: string | null;
  previewImage?: Uint8Array;
  quote: Quote | null;
  envelope?: string | null;
  normalizedOptions: Record<string, unknown>;
}

export interface Quote {
  postageHtCents: number | null;
  serviceHtCents: number | null;
  totalHtCents: number;
  currency: "EUR";
}

export interface SubmitResult {
  ref: ProviderRef;
  rawStatus: string | null;
  mappedStatus: DispatchStatus;
}

export interface ProviderEventInfo {
  eventId: string;
  eventType: string;
  rawStatus: string | null;
  mappedStatus: DispatchStatus | null;
  occurredAt: string;
}

export interface StatusResult {
  ref: ProviderRef;
  rawStatus: string | null;
  mappedStatus: DispatchStatus | null;
  events: ProviderEventInfo[];
  trackingNumber?: string | null;
  /** Le prestataire attend une validation de la lettre générée (Manuscry). */
  awaitingProviderValidation?: boolean;
  evidenceAvailable?: EvidenceKind[];
}

export interface EvidenceResult {
  kind: EvidenceKind;
  bytes: Uint8Array;
  mimeType: string;
  source: string;
}

/**
 * Webhook analysé. Il ne sert QU'À identifier l'envoi concerné et à dédupliquer :
 * l'état est toujours relu via l'API (rapprochement), car aucun des deux
 * prestataires ne documente de signature cryptographique.
 */
export interface ParsedWebhook {
  dedupKey: string;
  eventType: string;
  lookup: ProviderRef;
  occurredAt: string | null;
  payloadDigest: string;
  /** Événement à ignorer (ex. scan de QR sur patient). */
  ignore?: string;
}

export interface CapabilityInfo {
  status: "documented" | "confirmed_by_test" | "to_confirm_contractually" | "unsupported";
  note?: string;
}

export type CapabilityName =
  | "preview"
  | "quote"
  | "submit"
  | "schedule"
  | "providerValidation"
  | "cancel"
  | "status"
  | "evidence.final_document"
  | "evidence.deposit_proof"
  | "evidence.scanned_ar"
  | "webhooks"
  | "webhookSignature"
  | "block"
  | "attachments"
  | "registered"
  | "birthday"
  | "batch"
  | "sandbox";

export interface PostalProviderAdapter {
  readonly name: ProviderName;
  validateConfig(conn: ProviderConnection): Promise<ProviderResult<{ details: Record<string, unknown> }>>;
  getCapabilities(): Record<CapabilityName, CapabilityInfo>;
  createPreview(conn: ProviderConnection, req: SubmissionRequest): Promise<ProviderResult<PreviewResult>>;
  quote(conn: ProviderConnection, ref: ProviderRef): Promise<ProviderResult<Quote>>;
  submit(conn: ProviderConnection, req: SubmissionRequest, ref: ProviderRef): Promise<ProviderResult<SubmitResult>>;
  schedule(conn: ProviderConnection, ref: ProviderRef, date: string, reference: string): Promise<ProviderResult<SubmitResult>>;
  approve(conn: ProviderConnection, ref: ProviderRef, decision: "validate" | "reject"): Promise<ProviderResult<{ effectiveAt: string | null }>>;
  cancel(conn: ProviderConnection, ref: ProviderRef): Promise<ProviderResult<{ cancelled: boolean; message: string }>>;
  getStatus(conn: ProviderConnection, ref: ProviderRef): Promise<ProviderResult<StatusResult>>;
  fetchEvidence(conn: ProviderConnection, ref: ProviderRef, kind: EvidenceKind): Promise<ProviderResult<EvidenceResult>>;
  handleWebhook(rawBody: string, headers: Record<string, string>): ProviderResult<ParsedWebhook>;
  block(conn: ProviderConnection, ref: ProviderRef): Promise<ProviderResult<{ lettersCancelled: number | null }>>;
}

export interface SecretStore {
  get(ref: string): Promise<string>;
}

/** Secrets référencés `env:NOM_VARIABLE`. À remplacer par un vrai gestionnaire de secrets en production. */
export function envSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  return {
    async get(ref: string) {
      if (!ref.startsWith("env:")) throw new Error("Référence de secret non supportée");
      const v = env[ref.slice(4)];
      if (!v) throw new Error("Secret absent");
      return v;
    },
  };
}
