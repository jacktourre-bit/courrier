/** Types canoniques du module. Les noms reprennent le cahier des charges §10-11. */

export const PURPOSES = ["transactional", "administrative", "relationship", "marketing", "legal"] as const;
export type Purpose = (typeof PURPOSES)[number];

export const PROVIDERS = ["manuscry", "servicepostal"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** Niveau de sensibilité, ordonné du moins au plus sensible. */
export const SENSITIVITIES = ["public", "personal_non_health", "personal_sensitive", "health"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];
export const sensitivityRank = (s: Sensitivity): number => SENSITIVITIES.indexOf(s);
export const maxSensitivity = (...xs: Sensitivity[]): Sensitivity =>
  xs.reduce<Sensitivity>((a, b) => (sensitivityRank(b) > sensitivityRank(a) ? b : a), "public");

/** Codes Service Postal documentés (OpenAPI 1.7.0) ; `handwritten` = rendu Manuscry. */
export const POSTAGE_CLASSES = ["lrar", "lr", "ecopli", "verte", "vertesuivi", "performance", "perfsuivi", "handwritten"] as const;
export type PostageClass = (typeof POSTAGE_CLASSES)[number];
export const isRegistered = (p: PostageClass): boolean => p === "lr" || p === "lrar";
export const isTracked = (p: PostageClass): boolean => ["lr", "lrar", "vertesuivi", "perfsuivi"].includes(p);

export const DISPATCH_STATUSES = [
  "DRAFT",
  "READY_FOR_PREVIEW",
  "PREVIEWED",
  "PENDING_APPROVAL",
  "APPROVED",
  "SCHEDULED",
  "SUBMITTED",
  "IN_PRODUCTION",
  "POSTAL_DEPOSITED",
  "IN_TRANSIT",
  "DELIVERED",
  "REJECTED",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "RETURNED",
  "FAILED_VALIDATION",
  "FAILED_PROVIDER",
  "INSUFFICIENT_FUNDS",
  "UNKNOWN_SUBMISSION_STATUS",
  "EVIDENCE_PENDING",
] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export type SubjectType = "patient" | "organization" | "contact";
export type SourceType = "patient_file" | "organization_file" | "admin_file" | "campaign";

export interface PostalAddress {
  civility?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  service?: string | null;
  line1: string;
  line2?: string | null;
  line3?: string | null;
  postalCode: string;
  city: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

export interface Scope {
  tenantId: string;
  /** Entités juridiques accessibles ; `"*"` réservé aux tâches système. */
  legalEntityIds: string[] | "*";
  centerIds?: string[] | "*";
  userId: string | null;
}

export interface ProviderConnection {
  id: string;
  tenantId: string;
  legalEntityId: string;
  provider: ProviderName;
  environment: "sandbox" | "production";
  credentialsSecretRef: string;
  status: "active" | "disabled" | "error";
  lastTestedAt: string | null;
  capabilitiesJson: Record<string, unknown>;
  /** Paramètres non secrets : campaign_id par finalité, hôtes de documents autorisés, nom_entite… */
  settingsJson: Record<string, unknown>;
  webhookTokenHash: string | null;
  createdAt: string;
}

export interface SenderProfile {
  id: string;
  tenantId: string;
  legalEntityId: string;
  centerId: string | null;
  businessName: string;
  postalAddressJson: PostalAddress;
  contact: string | null;
  signatureAssetId: string | null;
  defaultProvider: ProviderName | null;
  /** Nom commercial discret pour l'enveloppe (secret professionnel). */
  envelopeDisplayName: string | null;
  active: boolean;
}

export interface RecipientAddress {
  id: string;
  tenantId: string;
  legalEntityId: string;
  subjectType: SubjectType;
  subjectId: string;
  addressJson: PostalAddress;
  verifiedAt: string | null;
  verificationSource: string | null;
  validityStatus: "valid" | "unverified" | "invalid" | "npai";
  version: number;
}

export interface Subject {
  id: string;
  tenantId: string;
  legalEntityId: string;
  centerId: string | null;
  type: SubjectType;
  civility: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  birthDate: string | null;
  /** MM-JJ dérivé de birthDate (index de l'automate d'anniversaires). */
  birthMd: string | null;
  birthDateReliable: boolean;
  deceased: boolean;
  archived: boolean;
  litigation: boolean;
  hasLegalRepresentative: boolean;
  publicReference: string | null;
}

export interface ContactPreference {
  id: string;
  tenantId: string;
  legalEntityId: string;
  subjectType: SubjectType;
  subjectId: string;
  purpose: Purpose | "birthday";
  channel: "postal";
  allowed: boolean;
  legalBasis: string | null;
  evidenceId: string | null;
  source: string;
  updatedAt: string;
}

export interface Organization {
  id: string;
  tenantId: string;
  legalEntityId: string | null;
  centerId: string | null;
  category: "cpam" | "mdph" | "mutuelle" | "caisse" | "bailleur" | "fournisseur" | "assureur" | "partenaire" | "banque" | "public" | "autre";
  name: string;
  branch: string | null;
  service: string | null;
  addressJson: PostalAddress;
  channelPolicy: { recommendedChannel: string; postalAccepted: boolean; notes?: string };
  verifiedAt: string | null;
  source: string | null;
  active: boolean;
  version: number;
}

export interface TemplateBlockContent {
  subject?: string;
  references?: string[];
  body: string;
  closing?: string;
  signatureName?: string;
  signatureTitle?: string;
  annexesList?: string[];
}

export interface Template {
  id: string;
  tenantId: string;
  legalEntityId: string;
  type: "formal" | "handwritten";
  provider: ProviderName;
  purpose: Purpose;
  title: string;
  status: "draft" | "approved" | "archived";
  currentVersionId: string | null;
}

export interface TemplateVersion {
  id: string;
  tenantId: string;
  legalEntityId: string;
  templateId: string;
  version: number;
  allowedMergeFieldsJson: string[];
  contentJson: TemplateBlockContent;
  /** Manuscry : champs de campagne lus via l'API (jamais codés en dur) + ai_context statique approuvé. */
  providerFieldsJson: {
    campaignId?: string;
    /** Variable de campagne Manuscry -> clé du registre de fusion. */
    fieldMap?: Record<string, string>;
    staticAiContext?: string | null;
  } | null;
  declaredSensitivity: Sensitivity;
  status: "draft" | "approved" | "archived";
  approvalsJson: { userId: string; at: string }[];
  contentHash: string;
  createdBy: string;
  createdAt: string;
}

export interface Dispatch {
  id: string;
  tenantId: string;
  legalEntityId: string;
  centerId: string | null;
  sourceType: SourceType;
  sourceId: string | null;
  subjectType: SubjectType;
  subjectId: string;
  purpose: Purpose;
  provider: ProviderName;
  providerUid: string | null;
  providerCampaignId: string | null;
  providerLetterId: string | null;
  providerLeadId: string | null;
  idempotencyKey: string;
  eventKey: string | null;
  reference: string;
  recipientSnapshotJson: PostalAddress;
  senderSnapshotJson: { businessName: string; address: PostalAddress; envelopeDisplayName: string | null };
  templateVersionId: string | null;
  mergeValuesJson: Record<string, string>;
  documentHash: string | null;
  documentAssetId: string | null;
  previewAssetId: string | null;
  approvalHash: string | null;
  sensitivity: Sensitivity;
  postageClass: PostageClass;
  optionsJson: { color?: "nb" | "couleur"; duplex?: "recto" | "rectoverso"; arScan?: boolean };
  approvalPolicy: "single" | "four_eyes" | "legal_double" | "sensitive" | "campaign_preapproved";
  scheduledFor: string | null;
  status: DispatchStatus;
  statusBeforeCancel: DispatchStatus | null;
  rawProviderStatus: string | null;
  lastSyncedAt: string | null;
  quoteHtCents: number | null;
  quoteTtcCents: number | null;
  quotePostageCents: number | null;
  quoteServiceCents: number | null;
  currency: "EUR";
  pageCount: number | null;
  approvedAt: string | null;
  approvedBy: string | null;
  submittedAt: string | null;
  deliveredAt: string | null;
  incident: string | null;
  trackingNumber: string | null;
  submissionAttemptedAt: string | null;
  campaignId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

export interface Attachment {
  id: string;
  tenantId: string;
  legalEntityId: string;
  dispatchId: string;
  assetId: string;
  filename: string;
  mimeType: string;
  checksumSha256: string;
  sensitivity: Sensitivity;
  category: AttachmentCategory;
  pageCount: number | null;
  orderIndex: number;
}

export const ATTACHMENT_CATEGORIES = [
  "administrative",
  "invoice",
  "quote",
  "identity",
  "contract",
  "medical_report",
  "audiogram",
  "prescription",
  "certificate",
  "mdph_file",
  "other",
] as const;
export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number];

export interface PostalEvent {
  id: string;
  tenantId: string;
  legalEntityId: string;
  dispatchId: string;
  provider: ProviderName | "internal";
  providerEventId: string;
  eventType: string;
  rawStatus: string | null;
  mappedStatus: DispatchStatus | null;
  occurredAt: string;
  receivedAt: string;
  payloadDigest: string;
}

export type EvidenceKind = "final_document" | "deposit_proof" | "tracking" | "scanned_ar" | "preview";

export interface Evidence {
  id: string;
  tenantId: string;
  legalEntityId: string;
  dispatchId: string;
  kind: EvidenceKind;
  securedAssetId: string;
  sha256: string;
  obtainedAt: string;
  source: string;
  retentionPolicy: string;
}

export interface Approval {
  id: string;
  tenantId: string;
  legalEntityId: string;
  dispatchId: string;
  step: ApprovalStep;
  approverUserId: string;
  action: "approve" | "reject" | "invalidated";
  reason: string | null;
  approvalHash: string;
  timestamp: string;
}
export type ApprovalStep = "review" | "final" | "final_legal" | "sensitive" | "budget_override";

export type OutboxAction = "SUBMIT" | "CANCEL" | "RECONCILE" | "FETCH_EVIDENCE" | "PROVIDER_VALIDATE" | "PROVIDER_BLOCK";
export interface OutboxItem {
  id: string;
  tenantId: string;
  legalEntityId: string;
  dispatchId: string;
  action: OutboxAction;
  payloadJson: Record<string, unknown>;
  payloadDigest: string;
  status: "pending" | "processing" | "done" | "dead" | "human_task";
  attempts: number;
  nextRetryAt: string;
  lastError: string | null;
  lockedUntil: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  tenantId: string;
  legalEntityId: string | null;
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string;
  timestamp: string;
  metadataRedacted: Record<string, unknown>;
}

export interface Campaign {
  id: string;
  tenantId: string;
  legalEntityId: string;
  centerId: string | null;
  type: "birthday" | "seasonal" | "thanks" | "loyalty" | "event" | "mailing";
  provider: ProviderName;
  providerCampaignId: string | null;
  templateVersionId: string;
  purpose: Purpose;
  schedulingRulesJson: BirthdayRules | Record<string, unknown>;
  budgetCents: number | null;
  status: "draft" | "approved" | "active" | "paused" | "archived";
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string;
}

export interface BirthdayRules {
  /** Qui possède la récurrence annuelle (cahier §5.2.8). Obligatoire avant activation. */
  recurrenceOwner: "saas" | "provider" | null;
  feb29Policy: "feb28" | "mar1";
  allowMinors: boolean;
  requireExplicitOptIn: boolean;
  addressMaxAgeDays: number;
  /** Jours avant l'anniversaire où le contact est transmis (doit précéder le délai prestataire). */
  submitWindowDays: number;
  /** `next_occurrence` : n'envoie pas l'année de naissance (minimisation). */
  birthdayDateMode: "next_occurrence" | "birth_date";
}

export interface CampaignRecipient {
  id: string;
  tenantId: string;
  legalEntityId: string;
  campaignId: string;
  subjectType: SubjectType;
  subjectId: string;
  eventKey: string;
  year: number;
  eligibilitySnapshotJson: Record<string, unknown>;
  dispatchId: string | null;
  outcome: "queued" | "skipped" | "dispatched";
  reason: string | null;
}

export interface Budget {
  id: string;
  tenantId: string;
  legalEntityId: string;
  centerId: string | null;
  campaignId: string | null;
  month: string;
  limitCents: number;
  alertThresholds: number[];
}

export interface SensitiveAuthorization {
  id: string;
  tenantId: string;
  legalEntityId: string;
  provider: ProviderName;
  templateId: string;
  documentRef: string;
  validatedBy: string;
  validatedAt: string;
  expiresAt: string | null;
}
