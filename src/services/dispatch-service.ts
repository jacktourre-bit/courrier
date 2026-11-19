/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Le cœur du module : la vie d'un courrier, de la création à l'envoi. Étapes : 1)
 * createDispatch : contrôles + fabrication du PDF ; 2) previewDispatch : aperçu et prix chez
 * le prestataire ; 3) requestApproval puis approveDispatch : approbations (une autre personne
 * que l'auteur) ; 4) l'approbation finale met le courrier dans la « file d'envoi », traitée
 * par le worker. Toute modification annule les approbations déjà données.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type {
  Approval,
  Attachment,
  AttachmentCategory,
  ContactPreference,
  Dispatch,
  DispatchStatus,
  Organization,
  OutboxAction,
  OutboxItem,
  PostageClass,
  PostalEvent,
  ProviderConnection,
  Purpose,
  RecipientAddress,
  SenderProfile,
  Sensitivity,
  SensitiveAuthorization,
  SourceType,
  Subject,
  SubjectType,
  Template,
  TemplateVersion,
} from "../domain/types.js";
import { isRegistered, isTracked } from "../domain/types.js";
import { assertTransition, PRE_SUBMISSION } from "../domain/state-machine.js";
import { normalizeAddress } from "../domain/address.js";
import { approvalPolicyFor, classifySensitivity, routeProvider } from "../domain/policy.js";
import { fieldCategory, resolveMergeValues, validateSensitiveValues } from "../domain/merge-fields.js";
import { PostalError } from "../lib/errors.js";
import { canonicalHash, opaqueRef, parisDate, sha256, uuid } from "../lib/util.js";
import { safeDownload } from "../lib/safe-fetch.js";
import { evaluateCompliance, type Blocker } from "./compliance.js";
import { renderFormalLetter } from "./renderer.js";
import { checkBudgets, recordBudgetAlerts } from "./budget.js";
import { audit, nowIso, readAsset, requireEntity, requireModule, requirePermission, resolveConnection, storeAsset, type Asset, type Ctx, type Deps } from "./context.js";
import type { Scope } from "../domain/types.js";
import type { SubmissionRequest } from "../providers/types.js";

// ------------------------------------------------------------------ Entrées

export interface CreateDispatchInput {
  legalEntityId: string;
  centerId: string | null;
  sourceType: SourceType;
  sourceId: string | null;
  subject: { type: SubjectType; id: string };
  recipient: { addressId: string } | { organizationId: string };
  purpose: Purpose;
  templateVersionId: string;
  postageClass: PostageClass;
  options?: Dispatch["optionsJson"];
  scheduledFor?: string | null;
  eventKey?: string | null;
  attachments?: { assetId: string; filename: string; category: AttachmentCategory; sensitivity: Sensitivity; justification?: string | null }[];
  /** P4 : valeurs sensibles (NIR, données de santé) saisies par un utilisateur habilité pour ce courrier. */
  sensitiveValues?: Record<string, string>;
  idempotencyKey: string;
  campaignId?: string | null;
  automated?: boolean;
  /** Préférence spécifique exigée (ex. `birthday`). */
  requiredPreference?: ContactPreference["purpose"];
  birthdayDate?: string | null;
}

// ------------------------------------------------------------- Chargements

interface Loaded {
  template: Template | null;
  version: TemplateVersion | null;
  sender: SenderProfile | null;
  address: RecipientAddress | null;
  organization: Organization | null;
  subject: Subject | null;
  preferences: ContactPreference[];
  attachments: { category: AttachmentCategory; declared: Sensitivity; asset: Asset | null }[];
  authorization: SensitiveAuthorization | null;
}

async function loadSender(ctx: Deps & { scope: Scope }, legalEntityId: string, centerId: string | null): Promise<SenderProfile | null> {
  if (centerId) {
    const s = await ctx.db.one<SenderProfile>("postal_sender_profiles", { legalEntityId, centerId, active: true });
    if (s) return s;
  }
  return ctx.db.one<SenderProfile>("postal_sender_profiles", { legalEntityId, centerId: null, active: true });
}

/** Adresse d'un organisme, exposée sous la forme d'une adresse destinataire versionnée. */
function orgAsAddress(o: Organization): RecipientAddress {
  return {
    id: `org:${o.id}:v${o.version}`,
    tenantId: o.tenantId,
    legalEntityId: o.legalEntityId ?? "",
    subjectType: "organization",
    subjectId: o.id,
    addressJson: { ...o.addressJson, company: o.addressJson.company ?? o.name, service: o.service ?? o.addressJson.service ?? null },
    verifiedAt: o.verifiedAt,
    verificationSource: o.source,
    validityStatus: o.verifiedAt ? "valid" : "unverified",
    version: o.version,
  };
}

// ------------------------------------------------------------- Compliance

function buildCompliance(ctx: Deps & { scope: Scope }, d: Pick<Dispatch, "purpose" | "provider" | "legalEntityId" | "subjectType" | "sensitivity" | "eventKey">, l: Loaded, extra: {
  duplicateDispatchId: string | null;
  automated: boolean;
  requiredPreference?: ContactPreference["purpose"];
  addressMaxAgeDays: number | null;
  allowMinors: boolean;
  requireExplicitOptIn: boolean;
}) {
  const attachmentCategories = l.attachments.map((a) => a.category);
  const address = l.organization ? orgAsAddress(l.organization) : l.address;
  // Un organisme public partagé (legalEntityId null) est utilisable par toute entité du tenant.
  if (address && l.organization && !l.organization.legalEntityId) address.legalEntityId = d.legalEntityId;
  return evaluateCompliance({
    purpose: d.purpose,
    provider: d.provider,
    legalEntityId: d.legalEntityId,
    subject: l.subject,
    subjectIsPatient: d.subjectType === "patient",
    recipientAddress: address,
    organization: l.organization,
    sender: l.sender,
    template: l.template,
    templateVersion: l.version,
    preferences: l.preferences,
    requiredPreference: extra.requiredPreference,
    requireExplicitOptIn: extra.requireExplicitOptIn,
    duplicateDispatchId: extra.duplicateDispatchId,
    sensitivity: d.sensitivity,
    sensitiveFlag: ctx.config.flags.SENSITIVE_POSTAL_ALLOWED,
    sensitiveAuthorization: l.authorization,
    automated: extra.automated,
    attachmentCategories,
    allowMinors: extra.allowMinors,
    addressMaxAgeDays: extra.addressMaxAgeDays,
    today: parisDate(ctx.clock.now()),
  });
}

function throwIfBlocked(blockers: Blocker[]) {
  if (blockers.length) {
    const sensitive = blockers.some((b) => b.code.startsWith("sensitive"));
    throw new PostalError(sensitive ? "SENSITIVE_BLOCKED" : "COMPLIANCE_BLOCKED", blockers.map((b) => b.message).join(" ; "), { blockers });
  }
}

// EN CLAIR : Charge d'un coup tout ce qu'il faut pour contrôler un courrier : modèle, expéditeur,
// adresse, organisme, personne, préférences, pièces, autorisation.
async function loadAll(ctx: Deps & { scope: Scope }, p: {
  legalEntityId: string;
  centerId: string | null;
  templateVersionId: string | null;
  subject: { type: SubjectType; id: string };
  addressId: string | null;
  organizationId: string | null;
  attachments: { assetId: string; category: AttachmentCategory; sensitivity: Sensitivity }[];
  provider: Dispatch["provider"] | null;
}): Promise<Loaded> {
  const version = p.templateVersionId ? await ctx.db.one<TemplateVersion>("postal_template_versions", { id: p.templateVersionId }) : null;
  const template = version ? await ctx.db.one<Template>("postal_templates", { id: version.templateId }) : null;
  const organization = p.organizationId ? await ctx.db.one<Organization>("postal_organizations", { id: p.organizationId }) : null;
  const address = p.addressId ? await ctx.db.one<RecipientAddress>("postal_recipient_addresses", { id: p.addressId }) : null;
  if (address && (address.subjectType !== p.subject.type || address.subjectId !== p.subject.id)) {
    throw new PostalError("VALIDATION", "L'adresse n'appartient pas à la personne concernée");
  }
  const subject = p.subject.type !== "organization" ? await ctx.db.one<Subject>("postal_subjects", { id: p.subject.id }) : null;
  if (p.subject.type !== "organization" && !subject) throw new PostalError("NOT_FOUND", "Personne concernée introuvable");
  const preferences = await ctx.db.find<ContactPreference>("postal_contact_preferences", { subjectType: p.subject.type, subjectId: p.subject.id, legalEntityId: p.legalEntityId });
  const attachments = [];
  for (const a of p.attachments) {
    const asset = await ctx.db.one<Asset>("postal_assets", { id: a.assetId, legalEntityId: p.legalEntityId });
    if (!asset) throw new PostalError("NOT_FOUND", "Pièce jointe introuvable pour cette société");
    attachments.push({ category: a.category, declared: a.sensitivity, asset });
  }
  const authorization =
    template && p.provider
      ? await ctx.db.one<SensitiveAuthorization>("postal_sensitive_authorizations", { legalEntityId: p.legalEntityId, provider: p.provider, templateId: template.id })
      : null;
  return { template, version, sender: await loadSender(ctx, p.legalEntityId, p.centerId), address, organization, subject, preferences, attachments, authorization };
}

// EN CLAIR : Refait les contrôles sur l'état actuel (une opposition peut être arrivée entre-temps).
/** Recharge l'état courant et ré-évalue la conformité (appelé avant chaque étape à risque). */
export async function recheckCompliance(ctx: Deps & { scope: Scope }, d: Dispatch): Promise<Blocker[]> {
  const atts = await ctx.db.find<Attachment>("postal_attachments", { dispatchId: d.id });
  const recipientRef = d.subjectType === "organization" ? { addressId: null, organizationId: d.subjectId } : { addressId: (d.optionsJson as { addressId?: string }).addressId ?? null, organizationId: (d.optionsJson as { organizationId?: string }).organizationId ?? null };
  const l = await loadAll(ctx, {
    legalEntityId: d.legalEntityId,
    centerId: d.centerId,
    templateVersionId: d.templateVersionId,
    subject: { type: d.subjectType, id: d.subjectId },
    addressId: recipientRef.addressId,
    organizationId: recipientRef.organizationId,
    attachments: atts.map((a) => ({ assetId: a.assetId, category: a.category, sensitivity: a.sensitivity })),
    provider: d.provider,
  });
  const campaign = d.campaignId ? await ctx.db.one<{ schedulingRulesJson: Record<string, unknown> }>("postal_campaigns", { id: d.campaignId }) : null;
  const rules = (campaign?.schedulingRulesJson ?? {}) as { allowMinors?: boolean; addressMaxAgeDays?: number; requireExplicitOptIn?: boolean };
  const r = buildCompliance(ctx, d, l, {
    duplicateDispatchId: null,
    automated: !!d.campaignId,
    requiredPreference: (d.optionsJson as { requiredPreference?: ContactPreference["purpose"] }).requiredPreference,
    addressMaxAgeDays: d.campaignId ? rules.addressMaxAgeDays ?? 730 : null,
    allowMinors: rules.allowMinors ?? false,
    requireExplicitOptIn: rules.requireExplicitOptIn ?? (d.purpose === "relationship" || d.purpose === "marketing"),
  });
  // L'instantané d'adresse approuvé reste la référence : seule une opposition / un décès bloque ici.
  return r.blockers.filter((b) => !b.code.startsWith("address_") || b.code === "address_invalid");
}

// ------------------------------------------------------------------ Création

// EN CLAIR : Crée un courrier : choisit le prestataire, calcule la sensibilité, vérifie la conformité,
// vérifie les pièces de santé et leur justification, remplit les variables, chiffre les données
// sensibles à part, puis fabrique le PDF. Si la même demande arrive deux fois (même clé), on renvoie
// le courrier déjà créé.
export async function createDispatch(ctx: Ctx, input: CreateDispatchInput): Promise<Dispatch> {
  requireModule(ctx);
  requirePermission(ctx, "postal.draft");
  requireEntity(ctx, input.legalEntityId, input.centerId);
  const existing = await ctx.db.one<Dispatch>("postal_dispatches", { tenantId: ctx.scope.tenantId, idempotencyKey: input.idempotencyKey });
  if (existing) return existing;

  const addressId = "addressId" in input.recipient ? input.recipient.addressId : null;
  const organizationId = "organizationId" in input.recipient ? input.recipient.organizationId : null;
  const preVersion = await ctx.db.one<TemplateVersion>("postal_template_versions", { id: input.templateVersionId });
  const preTemplate = preVersion ? await ctx.db.one<Template>("postal_templates", { id: preVersion.templateId }) : null;
  if (!preTemplate || !preVersion) throw new PostalError("NOT_FOUND", "Modèle introuvable");

  const provider = routeProvider({
    purpose: input.purpose,
    rendering: preTemplate.type === "handwritten" ? "handwritten" : "formal",
    postageClass: input.postageClass,
    hasAttachments: (input.attachments?.length ?? 0) > 0,
    needsProof: isRegistered(input.postageClass),
  });

  const l = await loadAll(ctx, {
    legalEntityId: input.legalEntityId,
    centerId: input.centerId,
    templateVersionId: input.templateVersionId,
    subject: input.subject,
    addressId,
    organizationId,
    attachments: input.attachments ?? [],
    provider,
  });
  const recipientAddr = l.organization ? orgAsAddress(l.organization) : l.address;
  if (!recipientAddr) throw new PostalError("VALIDATION", "Destinataire sans adresse");
  const recipient = normalizeAddress(recipientAddr.addressJson);

  const allowed = l.version!.allowedMergeFieldsJson;
  const sensBase = {
    declared: "public" as Sensitivity,
    subjectType: input.subject.type,
    concernsPatient: input.subject.type === "patient" || l.subject?.type === "patient",
    purpose: input.purpose,
  };
  const sens = classifySensitivity({
    declared: l.version!.declaredSensitivity,
    mergeFieldKeys: allowed,
    attachments: l.attachments.map((a) => ({ category: a.category, declared: a.declared })),
    subjectType: input.subject.type,
    concernsPatient: input.subject.type === "patient" || l.subject?.type === "patient",
    recipientOrgCategory: l.organization?.category ?? null,
    freeTexts: [l.version!.contentJson.body, l.version!.contentJson.subject ?? "", l.version!.providerFieldsJson?.staticAiContext ?? ""],
    purpose: input.purpose,
  });

  let duplicate: string | null = null;
  if (input.eventKey) {
    const dups = await ctx.db.find<Dispatch>("postal_dispatches", {
      legalEntityId: input.legalEntityId,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      eventKey: input.eventKey,
      status: { in: ["DRAFT", "READY_FOR_PREVIEW", "PREVIEWED", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "SUBMITTED", "IN_PRODUCTION", "POSTAL_DEPOSITED", "IN_TRANSIT", "DELIVERED", "UNKNOWN_SUBMISSION_STATUS", "CANCEL_REQUESTED", "INSUFFICIENT_FUNDS"] },
    });
    duplicate = dups[0]?.id ?? null;
  }

  const campaign = input.campaignId ? await ctx.db.one<{ schedulingRulesJson: Record<string, unknown> }>("postal_campaigns", { id: input.campaignId }) : null;
  const rules = (campaign?.schedulingRulesJson ?? {}) as { allowMinors?: boolean; addressMaxAgeDays?: number; requireExplicitOptIn?: boolean };
  const comp = buildCompliance(ctx, { purpose: input.purpose, provider, legalEntityId: input.legalEntityId, subjectType: input.subject.type, sensitivity: sens.level, eventKey: input.eventKey ?? null }, l, {
    duplicateDispatchId: duplicate,
    automated: !!input.automated,
    requiredPreference: input.requiredPreference,
    addressMaxAgeDays: input.automated ? rules.addressMaxAgeDays ?? 730 : null,
    allowMinors: rules.allowMinors ?? false,
    requireExplicitOptIn: rules.requireExplicitOptIn ?? (input.purpose === "relationship" || input.purpose === "marketing"),
  });
  throwIfBlocked(comp.blockers);

  // Pièces sensibles : choix explicite et justifié par un utilisateur habilité (§5.4.3).
  for (const a of input.attachments ?? []) {
    const level = classifySensitivity({ ...sensBase, attachments: [{ category: a.category, declared: a.sensitivity }], mergeFieldKeys: [], recipientOrgCategory: null, freeTexts: [] }).level;
    if (level === "health" || level === "personal_sensitive") {
      requirePermission(ctx, "postal.sensitive.attach");
      if (!a.justification || a.justification.trim().length < 10) throw new PostalError("VALIDATION", `Justification requise pour la pièce sensible « ${a.filename.slice(0, 60)} » (pourquoi est-elle indispensable ?)`);
    }
  }
  // Valeurs sensibles : saisies, jamais déduites du dossier ; stockées chiffrées hors de la base.
  const hasSensitiveFields = allowed.some((k) => ["health", "sensitive"].includes(fieldCategory(k) ?? ""));
  let sensitiveValues: Record<string, string> | null = null;
  if (hasSensitiveFields || input.sensitiveValues) {
    requirePermission(ctx, "postal.sensitive.enter");
    sensitiveValues = validateSensitiveValues(allowed, input.sensitiveValues ?? {});
  }

  // Valeurs de fusion (erreur bloquante si une valeur manque)
  const values = resolveMergeValues(allowed, {
    subject: l.subject,
    recipient,
    center: l.sender ? { name: l.sender.businessName, phone: l.sender.contact, address: [l.sender.postalAddressJson.line1, `${l.sender.postalAddressJson.postalCode} ${l.sender.postalAddressJson.city}`].join(", ") } : null,
    sender: { businessName: l.sender?.businessName ?? "", signatory: l.version!.contentJson.signatureName ?? null },
    today: parisDate(ctx.clock.now()),
  }, { skipSensitive: true });
  const sensitiveAsset = sensitiveValues
    ? await storeAsset(ctx, { tenantId: ctx.scope.tenantId, legalEntityId: input.legalEntityId, bytes: new TextEncoder().encode(JSON.stringify(sensitiveValues)), mimeType: "application/json", sensitivity: "health", kind: "sensitive_values" })
    : null;

  const now = nowIso(ctx);
  const sender = l.sender!;
  const d: Dispatch = {
    id: uuid(),
    tenantId: ctx.scope.tenantId,
    legalEntityId: input.legalEntityId,
    centerId: input.centerId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    subjectType: input.subject.type,
    subjectId: input.subject.id,
    purpose: input.purpose,
    provider,
    providerUid: null,
    providerCampaignId: provider === "manuscry" ? l.version!.providerFieldsJson?.campaignId ?? null : null,
    providerLetterId: null,
    providerLeadId: null,
    idempotencyKey: input.idempotencyKey,
    eventKey: input.eventKey ?? null,
    reference: opaqueRef(),
    recipientSnapshotJson: recipient,
    senderSnapshotJson: { businessName: sender.envelopeDisplayName ?? sender.businessName, address: normalizeAddress(sender.postalAddressJson), envelopeDisplayName: sender.envelopeDisplayName },
    templateVersionId: input.templateVersionId,
    mergeValuesJson: values,
    documentHash: null,
    documentAssetId: null,
    previewAssetId: null,
    approvalHash: null,
    sensitivity: sens.level,
    postageClass: input.postageClass,
    optionsJson: {
      ...input.options,
      // LRAR : AR dématérialisé par défaut pour disposer d'une preuve de réception numérique.
      ...(input.postageClass === "lrar" && input.options?.arScan === undefined ? { arScan: true } : {}),
      ...(addressId ? { addressId } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(input.requiredPreference ? { requiredPreference: input.requiredPreference } : {}),
      ...(input.birthdayDate ? { birthdayDate: input.birthdayDate } : {}),
      sensitivityReasons: sens.reasons,
      ...(sensitiveAsset ? { sensitiveValuesAssetId: sensitiveAsset.id } : {}),
      addressVersion: recipientAddr.version,
    } as Dispatch["optionsJson"],
    approvalPolicy: approvalPolicyFor({ purpose: input.purpose, postageClass: input.postageClass, sensitivity: sens.level, sourceType: input.sourceType }, !!input.automated && !!input.campaignId).policy,
    scheduledFor: input.scheduledFor ?? null,
    status: "DRAFT",
    statusBeforeCancel: null,
    rawProviderStatus: null,
    lastSyncedAt: null,
    quoteHtCents: null,
    quoteTtcCents: null,
    quotePostageCents: null,
    quoteServiceCents: null,
    currency: "EUR",
    pageCount: null,
    approvedAt: null,
    approvedBy: null,
    submittedAt: null,
    deliveredAt: null,
    incident: null,
    trackingNumber: null,
    submissionAttemptedAt: null,
    campaignId: input.campaignId ?? null,
    createdBy: ctx.scope.userId,
    createdAt: now,
    updatedAt: now,
    rowVersion: 1,
  };

  return ctx.db.tx(async (db) => {
    const tctx = { ...ctx, db };
    await db.insert("postal_dispatches", d);
    let i = 0;
    for (const a of input.attachments ?? []) {
      const asset = l.attachments[i]!.asset!;
      await db.insert<Attachment>("postal_attachments", {
        id: uuid(),
        tenantId: d.tenantId,
        legalEntityId: d.legalEntityId,
        dispatchId: d.id,
        assetId: asset.id,
        filename: a.filename.slice(0, 200),
        mimeType: asset.mimeType,
        checksumSha256: asset.sha256,
        sensitivity: a.sensitivity,
        category: a.category,
        pageCount: null,
        orderIndex: i++,
        justification: a.justification?.trim().slice(0, 500) ?? null,
        addedBy: ctx.scope.userId,
      });
      if (a.justification) await audit(tctx, { legalEntityId: d.legalEntityId, action: "dispatch.sensitive_attachment_added", objectType: "dispatch", objectId: d.id, metadata: { category: a.category, justification: a.justification.slice(0, 200) } });
    }
    await internalEvent(tctx, d, "created", "DRAFT");
    const warnings = [...comp.warnings];
    if (d.postageClass === "lrar" && !d.optionsJson.arScan) warnings.push("AR papier : retour physique, aucune preuve de réception numérique");
    await audit(tctx, { legalEntityId: d.legalEntityId, action: "dispatch.created", objectType: "dispatch", objectId: d.id, metadata: { purpose: d.purpose, provider, sensitivity: d.sensitivity, warnings } });
    return renderDocument(tctx, d);
  });
}

// ------------------------------------------------------------------ Rendu

// EN CLAIR : Réunit les variables normales et les variables sensibles (relues depuis le fichier
// chiffré) au moment de fabriquer le PDF.
/** Valeurs de rendu : non sensibles (base) + sensibles (actif chiffré), jamais persistées ensemble. */
async function renderValues(ctx: Deps & { scope: Scope }, d: Dispatch): Promise<Record<string, string>> {
  const id = (d.optionsJson as { sensitiveValuesAssetId?: string }).sensitiveValuesAssetId;
  if (!id) return d.mergeValuesJson;
  const { bytes } = await readAsset(ctx, id);
  return { ...d.mergeValuesJson, ...(JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>) };
}

// EN CLAIR : Fabrique le PDF (Service Postal) ou l'empreinte du contenu (Manuscry) et passe le
// courrier à « prêt pour aperçu ».
async function renderDocument(ctx: Ctx, d: Dispatch): Promise<Dispatch> {
  const version = await ctx.db.one<TemplateVersion>("postal_template_versions", { id: d.templateVersionId! });
  if (!version) throw new PostalError("NOT_FOUND", "Version de modèle introuvable");
  let documentHash: string;
  let documentAssetId: string | null = null;
  let pageCount: number | null = null;
  if (d.provider === "servicepostal") {
    const out = await renderFormalLetter({
      sender: { businessName: d.senderSnapshotJson.businessName, address: d.senderSnapshotJson.address },
      recipient: d.recipientSnapshotJson,
      content: version.contentJson,
      values: await renderValues(ctx, d),
      placeAndDate: `${d.senderSnapshotJson.address.city}, le ${d.mergeValuesJson["date.jour"] ?? parisDate(ctx.clock.now())}`,
      reference: d.reference,
    });
    const asset = await storeAsset(ctx, { tenantId: d.tenantId, legalEntityId: d.legalEntityId, bytes: out.bytes, mimeType: "application/pdf", sensitivity: d.sensitivity, kind: "generated_document" });
    documentAssetId = asset.id;
    documentHash = asset.sha256;
    pageCount = out.pageCount;
  } else {
    documentHash = canonicalHash({ v: version.contentHash, values: manuscryVariables(d, version), recipient: d.recipientSnapshotJson });
  }
  return transition(ctx, d, "READY_FOR_PREVIEW", { documentHash, documentAssetId, pageCount, approvalHash: null, previewAssetId: null, providerUid: null });
}

function manuscryVariables(d: Dispatch, v: TemplateVersion): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [providerKey, registryKey] of Object.entries(v.providerFieldsJson?.fieldMap ?? {})) {
    const val = d.mergeValuesJson[registryKey];
    if (val === undefined) throw new PostalError("VALIDATION", `Variable de campagne ${providerKey} sans valeur`);
    out[providerKey] = val;
  }
  return out;
}

// ------------------------------------------------------------- Transitions

// EN CLAIR : Fait avancer le courrier d'une étape. Si quelqu'un l'a modifié au même moment, refuse
// (pas d'écrasement silencieux).
export async function transition(ctx: Ctx | (Deps & { scope: Scope }), d: Dispatch, to: DispatchStatus, patch: Partial<Dispatch> = {}): Promise<Dispatch> {
  assertTransition(d.status, to);
  const next = { ...patch, status: to, updatedAt: nowIso(ctx), rowVersion: d.rowVersion + 1 };
  const n = await ctx.db.update("postal_dispatches", { id: d.id, rowVersion: d.rowVersion }, next);
  if (n !== 1) throw new PostalError("CONFLICT", "Envoi modifié simultanément, recharger");
  await internalEvent(ctx, { ...d, ...next }, `status:${to}`, to);
  return { ...d, ...next } as Dispatch;
}

// EN CLAIR : Ajoute un événement à l'historique du courrier (la chronologie du dossier).
export async function internalEvent(ctx: Deps & { scope: Scope }, d: Pick<Dispatch, "id" | "tenantId" | "legalEntityId">, type: string, status: DispatchStatus | null) {
  const at = nowIso(ctx);
  await ctx.db.insert<PostalEvent>("postal_events", {
    id: uuid(),
    tenantId: d.tenantId,
    legalEntityId: d.legalEntityId,
    dispatchId: d.id,
    provider: "internal",
    providerEventId: uuid(),
    eventType: type,
    rawStatus: null,
    mappedStatus: status,
    occurredAt: at,
    receivedAt: at,
    payloadDigest: sha256(`${d.id}|${type}|${at}`),
  });
}

// EN CLAIR : Lit un courrier en vérifiant les droits.
export async function getDispatch(ctx: Ctx, id: string): Promise<Dispatch> {
  requirePermission(ctx, "postal.read");
  const d = await ctx.db.one<Dispatch>("postal_dispatches", { id });
  if (!d) throw new PostalError("NOT_FOUND", "Envoi introuvable");
  requireEntity(ctx, d.legalEntityId, d.centerId);
  return d;
}

// ------------------------------------------------------------ Prévisualisation

// EN CLAIR : Calcule le prix TTC : l'affranchissement n'a pas de TVA, le service a 20 %.
export function ttcCents(ctx: Pick<Deps, "config">, postage: number | null, service: number | null, totalHt: number): number {
  if (postage === null || service === null) return Math.round(totalHt * (1 + ctx.config.serviceVatRate));
  return postage + Math.round(service * (1 + ctx.config.serviceVatRate));
}

// EN CLAIR : Prépare la demande au prestataire avec uniquement le nécessaire : adresse, PDF, pièces,
// référence opaque.
export async function buildSubmission(ctx: Ctx | (Deps & { scope: Scope }), d: Dispatch): Promise<SubmissionRequest> {
  const req: SubmissionRequest = {
    dispatchId: d.id,
    reference: d.reference,
    recipient: d.recipientSnapshotJson,
    sender: { businessName: d.senderSnapshotJson.businessName, address: d.senderSnapshotJson.address },
    postageClass: d.postageClass,
    options: { color: d.optionsJson.color, duplex: d.optionsJson.duplex, arScan: d.optionsJson.arScan },
  };
  if (d.provider === "servicepostal") {
    const doc = await readAsset(ctx, d.documentAssetId!);
    if (doc.asset.sha256 !== d.documentHash) throw new PostalError("CONFLICT", "Document modifié depuis le rendu");
    req.document = { bytes: doc.bytes, format: "pdf" };
    const atts = await ctx.db.find<Attachment>("postal_attachments", { dispatchId: d.id }, { orderBy: [["orderIndex", "asc"]] });
    req.annexes = [];
    for (const a of atts) {
      const x = await readAsset(ctx, a.assetId);
      if (x.asset.sha256 !== a.checksumSha256) throw new PostalError("CONFLICT", "Pièce jointe modifiée");
      req.annexes.push({ bytes: x.bytes, format: a.mimeType === "application/pdf" ? "pdf" : "docx" });
    }
    const conn = await ctx.db.one<ProviderConnection>("postal_provider_connections", { legalEntityId: d.legalEntityId, provider: "servicepostal", status: "active" });
    req.billingEntity = (conn?.settingsJson.billingEntity as string | undefined) ?? null;
  } else {
    const v = await ctx.db.one<TemplateVersion>("postal_template_versions", { id: d.templateVersionId! });
    req.campaignId = d.providerCampaignId ?? undefined;
    req.variables = manuscryVariables(d, v!);
    // ai_context : uniquement le texte statique approuvé du modèle, jamais de donnée du dossier.
    req.aiContext = v!.providerFieldsJson?.staticAiContext ?? null;
    const bday = (d.optionsJson as { birthdayDate?: string }).birthdayDate;
    if (bday) req.birthdayDate = bday;
    if (d.scheduledFor) req.scheduledAt = d.scheduledFor;
  }
  return req;
}

// EN CLAIR : Contrôle de confidentialité, puis aperçu et prix chez le prestataire. L'aperçu PDF est
// téléchargé et rangé chez nous, jamais montré par un lien du prestataire.
export async function previewDispatch(ctx: Ctx, id: string): Promise<Dispatch> {
  requireModule(ctx);
  requirePermission(ctx, "postal.draft");
  let d = await getDispatch(ctx, id);
  if (d.status !== "READY_FOR_PREVIEW" && d.status !== "PREVIEWED") throw new PostalError("INVALID_TRANSITION", `Prévisualisation impossible depuis ${d.status}`);
  if (d.status === "PREVIEWED") d = await transition(ctx, d, "DRAFT").then((x) => renderDocument(ctx, x));
  // Contrôle de confidentialité AVANT toute transmission au prestataire (§5.4.5).
  throwIfBlocked(await recheckCompliance(ctx, d));
  const { conn, adapter } = await resolveConnection(ctx, d.legalEntityId, d.provider);
  const req = await buildSubmission(ctx, d);
  const r = await adapter.createPreview(conn, req);
  const patch: Partial<Dispatch> = {};
  if (r.ok) {
    if (d.provider === "servicepostal") {
      if (!r.value.ref.uid) throw new PostalError("PROVIDER_ERROR", "UID de prévisualisation absent");
      patch.providerUid = r.value.ref.uid;
      if (!r.value.previewUrl) throw new PostalError("PROVIDER_ERROR", "PDF de prévisualisation absent");
      const hosts = (conn.settingsJson.documentHostSuffixes as string[] | undefined) ?? ["servicepostal.com"];
      const dl = await safeDownload(r.value.previewUrl, { allowedHostSuffixes: hosts, fetchImpl: ctx.fetchImpl, skipDnsCheck: ctx.skipDnsCheck === true });
      const asset = await storeAsset(ctx, { tenantId: d.tenantId, legalEntityId: d.legalEntityId, bytes: dl.bytes, mimeType: "application/pdf", sensitivity: d.sensitivity, kind: "provider_preview" });
      patch.previewAssetId = asset.id;
      let q = r.value.quote;
      if (!q) {
        const qr = await adapter.quote(conn, r.value.ref);
        q = qr.ok ? qr.value : null;
      }
      if (!q) throw new PostalError("PROVIDER_ERROR", "Prix indisponible : validation impossible");
      Object.assign(patch, { quoteHtCents: q.totalHtCents, quotePostageCents: q.postageHtCents, quoteServiceCents: q.serviceHtCents, quoteTtcCents: ttcCents(ctx, q.postageHtCents, q.serviceHtCents, q.totalHtCents) });
    } else if (r.value.previewImage) {
      const asset = await storeAsset(ctx, { tenantId: d.tenantId, legalEntityId: d.legalEntityId, bytes: r.value.previewImage, mimeType: "image/png", sensitivity: d.sensitivity, kind: "provider_preview" });
      patch.previewAssetId = asset.id;
    }
  } else if (d.provider === "manuscry" && r.kind === "UNSUPPORTED") {
    // Parcours alternatif : aperçu local non manuscrit, signalé comme tel.
    const v = await ctx.db.one<TemplateVersion>("postal_template_versions", { id: d.templateVersionId! });
    const out = await renderFormalLetter({
      sender: { businessName: d.senderSnapshotJson.businessName, address: d.senderSnapshotJson.address },
      recipient: d.recipientSnapshotJson,
      content: { ...v!.contentJson, subject: "APERÇU LOCAL NON CONTRACTUEL — rendu manuscrit généré par Manuscry" },
      values: d.mergeValuesJson,
      placeAndDate: parisDate(ctx.clock.now()),
      reference: d.reference,
    });
    const asset = await storeAsset(ctx, { tenantId: d.tenantId, legalEntityId: d.legalEntityId, bytes: out.bytes, mimeType: "application/pdf", sensitivity: d.sensitivity, kind: "local_preview" });
    patch.previewAssetId = asset.id;
    patch.incident = "Aperçu Manuscry non activé : aperçu local non contractuel";
    const est = (conn.settingsJson.unitCostTtcCents as number | undefined) ?? null;
    if (est !== null) Object.assign(patch, { quoteTtcCents: est, quoteHtCents: Math.round(est / (1 + ctx.config.serviceVatRate)) });
  } else {
    throw new PostalError(r.kind === "RATE_LIMITED" ? "RATE_LIMITED" : "PROVIDER_ERROR", `Prévisualisation refusée : ${r.message}`, { kind: r.kind });
  }
  d = await transition(ctx, d, "PREVIEWED", patch);
  await audit(ctx, { legalEntityId: d.legalEntityId, action: "dispatch.previewed", objectType: "dispatch", objectId: d.id, metadata: { provider: d.provider, quoteTtcCents: d.quoteTtcCents } });
  return d;
}

// --------------------------------------------------------------- Approbation

// EN CLAIR : Calcule l'empreinte de ce qu'on approuve (PDF, adresse, pièces, prix, options). Si un
// seul élément change, l'empreinte change.
export async function computeApprovalHash(ctx: Ctx | (Deps & { scope: Scope }), d: Dispatch): Promise<string> {
  const atts = await ctx.db.find<Attachment>("postal_attachments", { dispatchId: d.id }, { orderBy: [["orderIndex", "asc"]] });
  return canonicalHash({
    documentHash: d.documentHash,
    recipient: d.recipientSnapshotJson,
    sender: d.senderSnapshotJson,
    attachments: atts.map((a) => a.checksumSha256),
    postageClass: d.postageClass,
    options: { color: d.optionsJson.color, duplex: d.optionsJson.duplex, arScan: d.optionsJson.arScan },
    scheduledFor: d.scheduledFor,
    quoteTtcCents: d.quoteTtcCents,
    providerUid: d.providerUid,
  });
}

// EN CLAIR : Vérifie que le courrier n'a pas changé depuis la demande d'approbation.
export const contentMatchesApproval = (contentHash: string, approvalHash: string | null): boolean => !!approvalHash && approvalHash.split(":")[0] === contentHash;

// EN CLAIR : Ouvre un tour d'approbation. Une campagne déjà approuvée (anniversaire) passe
// directement.
export async function requestApproval(ctx: Ctx, id: string): Promise<Dispatch> {
  requireModule(ctx);
  requirePermission(ctx, "postal.draft");
  let d = await getDispatch(ctx, id);
  if (d.status !== "PREVIEWED") throw new PostalError("INVALID_TRANSITION", "Prévisualisation requise avant approbation");
  if (d.provider === "servicepostal" && (!d.previewAssetId || d.quoteTtcCents === null)) throw new PostalError("APPROVAL_REQUIRED", "Aperçu et prix requis");
  // `<hash du contenu>:<tour d'approbation>` : chaque demande ouvre un nouveau tour.
  const approvalHash = `${await computeApprovalHash(ctx, d)}:${uuid()}`;
  d = await transition(ctx, d, "PENDING_APPROVAL", { approvalHash });
  if (d.approvalPolicy === "campaign_preapproved") {
    const c = d.campaignId ? await ctx.db.one<{ status: string; approvedAt: string | null }>("postal_campaigns", { id: d.campaignId }) : null;
    if (!c || c.status !== "active" || !c.approvedAt) throw new PostalError("APPROVAL_REQUIRED", "Campagne non approuvée ou inactive");
    return finalizeApproval(ctx, d, null);
  }
  return d;
}

export function requiredSteps(d: Dispatch) {
  return approvalPolicyFor(d, d.approvalPolicy === "campaign_preapproved").steps;
}

// EN CLAIR : Enregistre une approbation. Contrôle : bonne permission, une autre personne que l'auteur,
// contenu inchangé, budget. Après la dernière étape, le courrier part dans la file d'envoi.
export async function approveDispatch(ctx: Ctx, id: string, opts: { reason?: string | null; budgetOverride?: boolean } = {}): Promise<Dispatch> {
  requireModule(ctx);
  let d = await getDispatch(ctx, id);
  if (d.status !== "PENDING_APPROVAL") throw new PostalError("INVALID_TRANSITION", `Approbation impossible depuis ${d.status}`);
  const current = d.approvalHash ?? "";
  if (!contentMatchesApproval(await computeApprovalHash(ctx, d), d.approvalHash)) {
    // Une modification de contenu, d'adresse, de pièce ou de prix invalide l'approbation (§14).
    await invalidateApprovals(ctx, d, "Contenu modifié depuis la demande d'approbation");
    throw new PostalError("CONFLICT", "Le courrier a changé : approbation invalidée, nouvelle prévisualisation requise");
  }
  const approvals = (await ctx.db.find<Approval>("postal_approvals", { dispatchId: d.id, approvalHash: current, action: "approve" })).toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
  const steps = requiredSteps(d);
  const done = new Set(approvals.map((a) => a.step));
  const next = steps.find((s) => !done.has(s.step));
  if (!next) return finalizeApproval(ctx, d, null);
  requirePermission(ctx, next.permission);
  const me = ctx.scope.userId!;
  if (next.fourEyes && (me === d.createdBy || approvals.some((a) => a.approverUserId === me))) {
    throw new PostalError("FORBIDDEN", "Principe des quatre yeux : un autre utilisateur habilité doit approuver");
  }
  if (!next.fourEyes && me === d.createdBy && !ctx.config.allowSelfApprovalRelationship) {
    throw new PostalError("FORBIDDEN", "Auto-approbation désactivée par la politique");
  }
  const isLast = steps.indexOf(next) === steps.length - 1;
  if (isLast) {
    const checks = await checkBudgets(ctx, d, d.quoteTtcCents ?? 0);
    if (checks.some((c) => c.exceeded)) {
      if (!opts.budgetOverride) throw new PostalError("BUDGET_EXCEEDED", "Budget dépassé : approbation exceptionnelle requise", { checks });
      requirePermission(ctx, "postal.budget.override");
      if (!opts.reason) throw new PostalError("VALIDATION", "Motif obligatoire pour un dépassement de budget");
      await recordApproval(ctx, d, "budget_override", "approve", opts.reason, current);
    }
    await recordBudgetAlerts(ctx, d, checks);
  }
  await recordApproval(ctx, d, next.step, "approve", opts.reason ?? null, current);
  if (isLast) return finalizeApproval(ctx, d, me);
  await audit(ctx, { legalEntityId: d.legalEntityId, action: `dispatch.approval_step.${next.step}`, objectType: "dispatch", objectId: d.id });
  return d;
}

async function recordApproval(ctx: Ctx, d: Dispatch, step: Approval["step"], action: Approval["action"], reason: string | null, hash: string) {
  await ctx.db.insert<Approval>("postal_approvals", {
    id: uuid(),
    tenantId: d.tenantId,
    legalEntityId: d.legalEntityId,
    dispatchId: d.id,
    step,
    approverUserId: ctx.scope.userId ?? "system",
    action,
    reason: reason?.slice(0, 500) ?? null,
    approvalHash: hash,
    timestamp: nowIso(ctx),
  });
}

// EN CLAIR : Dernière vérification de conformité, puis mise en file d'envoi (immédiate ou à la date
// programmée).
async function finalizeApproval(ctx: Ctx, d: Dispatch, approver: string | null): Promise<Dispatch> {
  throwIfBlocked(await recheckCompliance(ctx, d));
  const scheduledLater = !!d.scheduledFor && d.scheduledFor > parisDate(ctx.clock.now());
  d = await transition(ctx, d, scheduledLater ? "SCHEDULED" : "APPROVED", { approvedAt: nowIso(ctx), approvedBy: approver });
  await enqueue(ctx, d, "SUBMIT", {}, scheduledLater ? scheduleInstant(d.scheduledFor!) : nowIso(ctx));
  await audit(ctx, { legalEntityId: d.legalEntityId, action: "dispatch.approved", objectType: "dispatch", objectId: d.id, metadata: { policy: d.approvalPolicy, scheduledFor: d.scheduledFor } });
  return d;
}

// EN CLAIR : Pour un envoi programmé : émission le jour J à 8 h, heure de Paris.
/** Envoi programmé : soumission le jour J à 08:00 Europe/Paris (≈ 07:00 UTC hiver, 06:00 été). */
export function scheduleInstant(isoDate: string): string {
  const probe = new Date(`${isoDate}T08:00:00Z`);
  const parisHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).format(probe));
  return new Date(probe.getTime() - (parisHour - 8) * 3_600_000).toISOString();
}

// EN CLAIR : Refus motivé par l'approbateur.
export async function rejectDispatch(ctx: Ctx, id: string, reason: string): Promise<Dispatch> {
  requirePermission(ctx, "postal.approve");
  const d = await getDispatch(ctx, id);
  if (d.status !== "PENDING_APPROVAL") throw new PostalError("INVALID_TRANSITION", "Refus impossible");
  await recordApproval(ctx, d, "final", "reject", reason, d.approvalHash ?? "");
  await audit(ctx, { legalEntityId: d.legalEntityId, action: "dispatch.rejected", objectType: "dispatch", objectId: d.id });
  return transition(ctx, d, "REJECTED");
}

// EN CLAIR : Annule les approbations quand le courrier a changé ; l'historique est conservé.
async function invalidateApprovals(ctx: Ctx, d: Dispatch, reason: string) {
  // Historique d'approbation append-only : on trace l'invalidation, on ne réécrit rien.
  await recordApproval(ctx, d, "final", "invalidated", reason, d.approvalHash ?? "");
  await ctx.db.update("postal_outbox", { dispatchId: d.id, action: "SUBMIT", status: { in: ["pending", "processing"] } }, { status: "done", lastError: "annulé : approbation invalidée" });
  await transition(ctx, d, "DRAFT", { approvalHash: null, approvedAt: null, approvedBy: null });
  await audit(ctx, { legalEntityId: d.legalEntityId, action: "dispatch.approvals_invalidated", objectType: "dispatch", objectId: d.id, metadata: { reason } });
}

// EN CLAIR : Modifie un courrier pas encore envoyé (adresse, date, affranchissement) : les
// approbations sont annulées et le PDF refait.
/** Modification avant soumission : invalide les approbations et repasse par le rendu. */
export async function modifyDispatch(ctx: Ctx, id: string, change: { scheduledFor?: string | null; postageClass?: PostageClass; options?: Dispatch["optionsJson"]; recipientAddressId?: string }): Promise<Dispatch> {
  requirePermission(ctx, "postal.draft");
  let d = await getDispatch(ctx, id);
  if (!PRE_SUBMISSION.includes(d.status)) throw new PostalError("INVALID_TRANSITION", "Envoi déjà transmis : modification impossible");
  if (change.postageClass && change.postageClass !== d.postageClass) {
    routeProvider({ purpose: d.purpose, rendering: d.provider === "manuscry" ? "handwritten" : "formal", postageClass: change.postageClass, hasAttachments: false, needsProof: false });
  }
  let recipient = d.recipientSnapshotJson;
  let options = { ...d.optionsJson, ...change.options };
  if (change.recipientAddressId) {
    const a = await ctx.db.one<RecipientAddress>("postal_recipient_addresses", { id: change.recipientAddressId, subjectType: d.subjectType, subjectId: d.subjectId });
    if (!a) throw new PostalError("NOT_FOUND", "Adresse introuvable pour cette personne");
    recipient = normalizeAddress(a.addressJson);
    options = { ...options, addressId: a.id, addressVersion: a.version } as Dispatch["optionsJson"];
  }
  if (d.status === "PENDING_APPROVAL") {
    await invalidateApprovals(ctx, d, "Modification du courrier");
    d = (await ctx.db.one<Dispatch>("postal_dispatches", { id }))!;
  } else if (d.status !== "DRAFT") {
    d = await transition(ctx, d, "DRAFT");
    await ctx.db.update("postal_outbox", { dispatchId: d.id, action: "SUBMIT", status: { in: ["pending", "processing"] } }, { status: "done", lastError: "annulé : courrier modifié" });
  }
  // Les variables « destinataire.* » suivent la nouvelle adresse.
  const mergeValuesJson = { ...d.mergeValuesJson };
  const recompute: Record<string, string | null | undefined> = {
    "destinataire.nom_complet": [recipient.civility, recipient.firstName, recipient.lastName].filter(Boolean).join(" ") || null,
    "destinataire.societe": recipient.company,
    "destinataire.service": recipient.service,
  };
  for (const k of Object.keys(mergeValuesJson)) {
    if (k in recompute) {
      const v = recompute[k];
      if (!v) throw new PostalError("VALIDATION", `Valeur manquante pour ${k}`);
      mergeValuesJson[k] = v;
    }
  }
  const patch = {
    recipientSnapshotJson: recipient,
    mergeValuesJson,
    optionsJson: options,
    scheduledFor: change.scheduledFor !== undefined ? change.scheduledFor : d.scheduledFor,
    postageClass: change.postageClass ?? d.postageClass,
    approvedAt: null,
    approvedBy: null,
    updatedAt: nowIso(ctx),
    rowVersion: d.rowVersion + 1,
  };
  await ctx.db.update("postal_dispatches", { id: d.id, rowVersion: d.rowVersion }, patch);
  d = { ...d, ...patch } as Dispatch;
  await audit(ctx, { legalEntityId: d.legalEntityId, action: "dispatch.modified", objectType: "dispatch", objectId: d.id, metadata: { fields: Object.keys(change) } });
  return renderDocument(ctx, d);
}

// ------------------------------------------------------------------ Annulation

// EN CLAIR : Annule : directement si rien n'est parti, sinon demande au prestataire.
export async function cancelDispatch(ctx: Ctx, id: string, reason: string): Promise<Dispatch> {
  requirePermission(ctx, "postal.cancel");
  const d = await getDispatch(ctx, id);
  await audit(ctx, { legalEntityId: d.legalEntityId, action: "dispatch.cancel_requested", objectType: "dispatch", objectId: d.id, metadata: { reason } });
  if (PRE_SUBMISSION.includes(d.status)) {
    await ctx.db.update("postal_outbox", { dispatchId: d.id, status: { in: ["pending", "processing"] } }, { status: "done", lastError: "annulé localement" });
    return transition(ctx, d, "CANCELLED");
  }
  if (d.status === "SUBMITTED" || d.status === "IN_PRODUCTION") {
    const next = await transition(ctx, d, "CANCEL_REQUESTED", { statusBeforeCancel: d.status });
    await enqueue(ctx, next, "CANCEL", {}, nowIso(ctx));
    return next;
  }
  throw new PostalError("INVALID_TRANSITION", `Annulation impossible au statut ${d.status}`);
}

// ------------------------------------------------------------------- Outbox

// EN CLAIR : Ajoute une tâche dans la file d'envoi (outbox), traitée par le worker.
export async function enqueue(ctx: Deps & { scope: Scope }, d: Pick<Dispatch, "id" | "tenantId" | "legalEntityId">, action: OutboxAction, payload: Record<string, unknown>, at: string) {
  await ctx.db.insert<OutboxItem>("postal_outbox", {
    id: uuid(),
    tenantId: d.tenantId,
    legalEntityId: d.legalEntityId,
    dispatchId: d.id,
    action,
    payloadJson: payload,
    payloadDigest: canonicalHash(payload),
    status: "pending",
    attempts: 0,
    nextRetryAt: at,
    lastError: null,
    lockedUntil: null,
    createdAt: nowIso(ctx),
  });
}

// EN CLAIR : Télécharge le PDF pour l'envoyer par un autre canal autorisé (quand l'envoi externe est
// interdit).
/** Export sécurisé (canal déjà autorisé) quand l'envoi externe est interdit (§5.4.4). */
export async function exportDocument(ctx: Ctx, id: string): Promise<{ bytes: Uint8Array; filename: string }> {
  requirePermission(ctx, "postal.export");
  const d = await getDispatch(ctx, id);
  if (!d.documentAssetId) throw new PostalError("NOT_FOUND", "Aucun document généré");
  const { bytes } = await readAsset(ctx, d.documentAssetId);
  await audit(ctx, { legalEntityId: d.legalEntityId, action: "dispatch.exported", objectType: "dispatch", objectId: d.id, metadata: { sensitivity: d.sensitivity } });
  return { bytes, filename: `${d.reference}.pdf` };
}

// EN CLAIR : Liste les preuves qu'on doit obtenir selon l'affranchissement : PDF imprimé ; + preuve de
// dépôt pour LR/LRAR ; + AR scanné pour LRAR ; + historique de suivi.
export const evidenceExpected = (d: Dispatch): string[] => {
  if (d.provider !== "servicepostal") return [];
  const out = ["final_document"];
  if (isRegistered(d.postageClass)) out.push("deposit_proof");
  if (d.postageClass === "lrar" && d.optionsJson.arScan) out.push("scanned_ar");
  if (isTracked(d.postageClass)) out.push("tracking");
  return out;
};


export { buildSubmission as buildSubmissionForWorker };
