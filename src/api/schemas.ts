import { z } from "zod";
import { ATTACHMENT_CATEGORIES, POSTAGE_CLASSES, PROVIDERS, PURPOSES, SENSITIVITIES, DISPATCH_STATUSES } from "../domain/types.js";
import { ROLES } from "../domain/policy.js";

const id = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const line = z.string().max(200);

export const AddressSchema = z
  .object({
    civility: line.nullish(),
    firstName: line.nullish(),
    lastName: line.nullish(),
    company: line.nullish(),
    service: line.nullish(),
    line1: z.string().min(1).max(200),
    line2: line.nullish(),
    line3: line.nullish(),
    postalCode: z.string().min(1).max(20),
    city: z.string().min(1).max(100),
    country: z.string().length(2),
  })
  .strict();

export const CreateDispatchSchema = z
  .object({
    legal_entity_id: id,
    center_id: id.nullable(),
    source_type: z.enum(["patient_file", "organization_file", "admin_file", "campaign"]),
    source_id: id.nullable().optional(),
    subject: z.object({ type: z.enum(["patient", "organization", "contact"]), id }).strict(),
    recipient: z.union([z.object({ address_id: id }).strict(), z.object({ organization_id: id }).strict()]),
    purpose: z.enum(PURPOSES),
    template_version_id: id,
    postage_class: z.enum(POSTAGE_CLASSES),
    options: z.object({ color: z.enum(["nb", "couleur"]).optional(), duplex: z.enum(["recto", "rectoverso"]).optional(), arScan: z.boolean().optional() }).strict().optional(),
    scheduled_for: isoDate.nullable().optional(),
    event_key: z.string().max(80).nullable().optional(),
    attachments: z
      .array(z.object({ asset_id: id, filename: z.string().min(1).max(200), category: z.enum(ATTACHMENT_CATEGORIES), sensitivity: z.enum(SENSITIVITIES), justification: z.string().max(500).nullish() }).strict())
      .max(10)
      .optional(),
    sensitive_values: z.record(z.string().max(60), z.string().max(300)).optional(),
  })
  .strict();

export const ModifyDispatchSchema = z
  .object({
    scheduled_for: isoDate.nullable().optional(),
    postage_class: z.enum(POSTAGE_CLASSES).optional(),
    options: z.object({ color: z.enum(["nb", "couleur"]).optional(), duplex: z.enum(["recto", "rectoverso"]).optional(), arScan: z.boolean().optional() }).strict().optional(),
    recipient_address_id: id.optional(),
  })
  .strict();

export const ApproveSchema = z.object({ reason: z.string().max(500).nullish(), budget_override: z.boolean().optional() }).strict();
export const ReasonSchema = z.object({ reason: z.string().min(1).max(500) }).strict();
export const ProviderDecisionSchema = z.object({ decision: z.enum(["validate", "reject"]) }).strict();

export const CreateTemplateSchema = z
  .object({ legal_entity_id: id, type: z.enum(["formal", "handwritten"]), provider: z.enum(PROVIDERS), purpose: z.enum(PURPOSES), title: z.string().min(1).max(200) })
  .strict();

export const TemplateVersionSchema = z
  .object({
    allowed_merge_fields: z.array(z.string().max(60)).max(30),
    content: z
      .object({
        subject: z.string().max(300).optional(),
        references: z.array(z.string().max(200)).max(5).optional(),
        body: z.string().min(1).max(20_000),
        closing: z.string().max(1000).optional(),
        signatureName: z.string().max(100).optional(),
        signatureTitle: z.string().max(100).optional(),
        annexesList: z.array(z.string().max(200)).max(20).optional(),
      })
      .strict(),
    declared_sensitivity: z.enum(SENSITIVITIES),
    provider: z.object({ campaign_id: z.string().min(1).max(64), field_map: z.record(z.string().max(60), z.string().max(60)), static_ai_context: z.string().max(1000).nullish() }).strict().optional(),
  })
  .strict();

export const ConnectionSchema = z
  .object({
    legal_entity_id: id,
    provider: z.enum(PROVIDERS),
    environment: z.enum(["sandbox", "production"]),
    credentials_secret_ref: z.string().min(5).max(200),
    settings: z
      .object({
        campaigns: z.record(z.string().max(40), z.string().max(64)).optional(),
        documentHostSuffixes: z.array(z.string().max(100)).max(5).optional(),
        billingEntity: z.string().max(100).optional(),
        partnerPreviewEnabled: z.boolean().optional(),
        unitCostTtcCents: z.number().int().min(0).max(100_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PreferenceSchema = z
  .object({
    legal_entity_id: id,
    subject_type: z.enum(["patient", "organization", "contact"]),
    subject_id: id,
    purpose: z.enum([...PURPOSES, "birthday"]),
    allowed: z.boolean(),
    legal_basis: z.string().max(100).nullish(),
    evidence_id: z.string().max(100).nullish(),
    source: z.string().min(1).max(80),
  })
  .strict();

export const SubjectSchema = z
  .object({
    id: id.optional(),
    legal_entity_id: id,
    center_id: id.nullable(),
    type: z.enum(["patient", "contact"]),
    civility: line.nullable(),
    first_name: line.nullable(),
    last_name: line.nullable(),
    company: line.nullable(),
    birth_date: isoDate.nullable(),
    birth_date_reliable: z.boolean(),
    deceased: z.boolean(),
    archived: z.boolean(),
    litigation: z.boolean(),
    has_legal_representative: z.boolean(),
    public_reference: z.string().max(60).nullable(),
  })
  .strict();

export const AddressCreateSchema = z
  .object({ legal_entity_id: id, subject_type: z.enum(["patient", "organization", "contact"]), subject_id: id, address: AddressSchema, verified_at: z.iso.datetime().nullish(), verification_source: z.string().max(80).nullish() })
  .strict();

export const OrganizationSchema = z
  .object({
    id: id.optional(),
    legal_entity_id: id.nullable(),
    center_id: id.nullable(),
    category: z.enum(["cpam", "mdph", "mutuelle", "caisse", "bailleur", "fournisseur", "assureur", "partenaire", "banque", "public", "autre"]),
    name: z.string().min(1).max(200),
    branch: line.nullable(),
    service: line.nullable(),
    address: AddressSchema,
    channel_policy: z.object({ recommendedChannel: z.string().max(80), postalAccepted: z.boolean(), notes: z.string().max(500).optional() }).strict(),
    verified_at: z.iso.datetime().nullable(),
    source: z.string().max(200).nullable(),
    active: z.boolean(),
  })
  .strict();

export const SenderProfileSchema = z
  .object({
    id: id.optional(),
    legal_entity_id: id,
    center_id: id.nullable(),
    business_name: z.string().min(1).max(38),
    envelope_display_name: z.string().max(38).nullable(),
    address: AddressSchema,
    contact: z.string().max(100).nullable(),
    default_provider: z.enum(PROVIDERS).nullable(),
    active: z.boolean(),
  })
  .strict();

export const BudgetSchema = z
  .object({ legal_entity_id: id, center_id: id.nullable(), campaign_id: id.nullable(), month: z.string().regex(/^\d{4}-\d{2}$/), limit_cents: z.number().int().min(0), alert_thresholds: z.array(z.number().min(0).max(2)).max(5).optional() })
  .strict();

export const SensitiveAuthSchema = z
  .object({
    legal_entity_id: id,
    provider: z.enum(PROVIDERS),
    template_id: id,
    document_ref: z.string().min(3).max(200),
    dpa_ref: z.string().min(3).max(200),
    qualification: z.enum(["hds_certified", "hds_out_of_scope_justified"]),
    certificate_ref: z.string().max(200).nullable(),
    certificate_scope: z.string().max(300).nullable(),
    certificate_expires_at: z.iso.datetime().nullable(),
    allowed_attachment_categories: z.array(z.enum(ATTACHMENT_CATEGORIES)).max(20),
    allowed_recipient_categories: z.array(z.enum(["cpam", "mdph", "mutuelle", "caisse", "assureur", "public", "autre"])).min(1).max(10),
    expires_at: z.iso.datetime().nullable(),
  })
  .strict();

export const RetentionSchema = z
  .object({ legal_entity_id: id, asset_kind: z.string().min(3).max(60), retain_days: z.number().int().min(1).max(36500), legal_basis: z.string().min(3).max(300) })
  .strict();

export const CampaignSchema = z
  .object({
    legal_entity_id: id,
    center_id: id.nullable(),
    type: z.enum(["birthday", "seasonal", "thanks", "loyalty", "event", "mailing"]),
    template_version_id: id,
    purpose: z.enum(PURPOSES),
    budget_cents: z.number().int().min(0).nullable().optional(),
    rules: z
      .object({
        recurrenceOwner: z.enum(["saas", "provider"]).nullable().optional(),
        feb29Policy: z.enum(["feb28", "mar1"]).optional(),
        allowMinors: z.boolean().optional(),
        requireExplicitOptIn: z.boolean().optional(),
        addressMaxAgeDays: z.number().int().min(30).max(3650).optional(),
        submitWindowDays: z.number().int().min(13).max(90).optional(),
        birthdayDateMode: z.enum(["next_occurrence", "birth_date"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const AssetUploadSchema = z
  .object({ legal_entity_id: id, filename: z.string().min(1).max(200), mime_type: z.string().max(100), content_base64: z.string().min(1).max(21_000_000), sensitivity: z.enum(SENSITIVITIES) })
  .strict();

export const ListSchema = z
  .object({ status: z.enum(DISPATCH_STATUSES).optional(), page: z.coerce.number().int().min(1).max(10_000).default(1), per_page: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();

export { ROLES };
