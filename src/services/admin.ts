import { randomBytes } from "node:crypto";
import type {
  Budget,
  Organization,
  PostalAddress,
  ProviderConnection,
  ProviderName,
  RecipientAddress,
  SenderProfile,
  SensitiveAuthorization,
  Subject,
  SubjectType,
} from "../domain/types.js";
import { normalizeAddress, validateAddress } from "../domain/address.js";
import { PostalError } from "../lib/errors.js";
import { sha256, uuid } from "../lib/util.js";
import { audit, nowIso, requireEntity, requirePermission, type Ctx } from "./context.js";

// ------------------------------------------------------------ Connexions

export async function createConnection(
  ctx: Ctx,
  i: { legalEntityId: string; provider: ProviderName; environment: "sandbox" | "production"; credentialsSecretRef: string; settings?: Record<string, unknown> },
): Promise<{ connection: ProviderConnection; webhookToken: string }> {
  requirePermission(ctx, "postal.config.manage");
  requireEntity(ctx, i.legalEntityId);
  if (i.environment === "production" && !ctx.config.flags.POSTAL_PRODUCTION_PROVIDERS_ALLOWED) throw new PostalError("FORBIDDEN", "Connexion production interdite dans cet environnement");
  if (!/^(env|vault):[A-Za-z0-9_\-/.]+$/.test(i.credentialsSecretRef)) throw new PostalError("VALIDATION", "Référence de secret invalide (jamais la clé elle-même)");
  // Jeton webhook : affiché une seule fois, seul son hachage est stocké.
  const webhookToken = randomBytes(32).toString("base64url");
  const c: ProviderConnection = {
    id: uuid(),
    tenantId: ctx.scope.tenantId,
    legalEntityId: i.legalEntityId,
    provider: i.provider,
    environment: i.environment,
    credentialsSecretRef: i.credentialsSecretRef,
    status: "active",
    lastTestedAt: null,
    capabilitiesJson: ctx.adapters[i.provider]?.getCapabilities() ?? {},
    settingsJson: sanitizeSettings(i.settings ?? {}),
    webhookTokenHash: sha256(webhookToken),
    createdAt: nowIso(ctx),
  };
  await ctx.db.insert("postal_provider_connections", c);
  await audit(ctx, { legalEntityId: i.legalEntityId, action: "connection.created", objectType: "provider_connection", objectId: c.id, metadata: { provider: i.provider, environment: i.environment } });
  return { connection: c, webhookToken };
}

const ALLOWED_SETTINGS = ["campaigns", "documentHostSuffixes", "billingEntity", "partnerPreviewEnabled", "unitCostTtcCents"];
function sanitizeSettings(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ALLOWED_SETTINGS) if (k in s) out[k] = s[k];
  return out;
}

export async function testConnection(ctx: Ctx, id: string) {
  requirePermission(ctx, "postal.config.manage");
  const c = await ctx.db.one<ProviderConnection>("postal_provider_connections", { id });
  if (!c) throw new PostalError("NOT_FOUND", "Connexion introuvable");
  requireEntity(ctx, c.legalEntityId);
  const adapter = ctx.adapters[c.provider];
  if (!adapter) throw new PostalError("PROVIDER_DISABLED", "Adaptateur absent");
  const r = await adapter.validateConfig(c);
  await ctx.db.update("postal_provider_connections", { id }, { lastTestedAt: nowIso(ctx), status: r.ok ? "active" : "error", capabilitiesJson: adapter.getCapabilities() });
  await audit(ctx, { legalEntityId: c.legalEntityId, action: "connection.tested", objectType: "provider_connection", objectId: id, metadata: { ok: r.ok, kind: r.ok ? null : r.kind } });
  return r.ok ? { ok: true, details: r.value.details } : { ok: false, kind: r.kind, message: r.message };
}

// --------------------------------------------------------------- Annuaire

export async function upsertSubject(ctx: Ctx, s: Omit<Subject, "tenantId" | "birthMd" | "id"> & { id?: string }): Promise<Subject> {
  requirePermission(ctx, "postal.directory.manage");
  requireEntity(ctx, s.legalEntityId, s.centerId);
  if (s.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(s.birthDate)) throw new PostalError("VALIDATION", "Date de naissance AAAA-MM-JJ");
  const row: Subject = { ...s, id: s.id ?? uuid(), tenantId: ctx.scope.tenantId, birthMd: s.birthDate ? s.birthDate.slice(5) : null };
  const existing = await ctx.db.one<Subject>("postal_subjects", { id: row.id });
  if (existing) await ctx.db.update("postal_subjects", { id: row.id }, row as unknown as Record<string, unknown>);
  else await ctx.db.insert("postal_subjects", row);
  return row;
}

/** Nouvelle adresse = nouvelle version ; les envois approuvés gardent leur instantané. */
export async function addRecipientAddress(ctx: Ctx, i: { legalEntityId: string; subjectType: SubjectType; subjectId: string; address: PostalAddress; verifiedAt?: string | null; verificationSource?: string | null }): Promise<RecipientAddress> {
  requirePermission(ctx, "postal.directory.manage");
  requireEntity(ctx, i.legalEntityId);
  const a = normalizeAddress(i.address);
  const issues = validateAddress(a);
  const prev = await ctx.db.find<RecipientAddress>("postal_recipient_addresses", { subjectType: i.subjectType, subjectId: i.subjectId, legalEntityId: i.legalEntityId }, { orderBy: [["version", "desc"]], limit: 1 });
  const row: RecipientAddress = {
    id: uuid(),
    tenantId: ctx.scope.tenantId,
    legalEntityId: i.legalEntityId,
    subjectType: i.subjectType,
    subjectId: i.subjectId,
    addressJson: a,
    verifiedAt: i.verifiedAt ?? null,
    verificationSource: i.verificationSource ?? null,
    validityStatus: issues.length ? "invalid" : i.verifiedAt ? "valid" : "unverified",
    version: (prev[0]?.version ?? 0) + 1,
  };
  await ctx.db.insert("postal_recipient_addresses", row);
  // L'ancienne version reste consultable mais n'est plus « valide » pour de nouveaux envois.
  if (prev[0] && prev[0].validityStatus === "valid") await ctx.db.update("postal_recipient_addresses", { id: prev[0].id }, { validityStatus: "unverified" });
  await audit(ctx, { legalEntityId: i.legalEntityId, action: "address.added", objectType: i.subjectType, objectId: i.subjectId, metadata: { version: row.version, issues: issues.map((x) => x.code) } });
  return row;
}

export async function upsertOrganization(ctx: Ctx, o: Omit<Organization, "tenantId" | "version" | "id"> & { id?: string }): Promise<Organization> {
  requirePermission(ctx, "postal.organizations.manage");
  if (o.legalEntityId) requireEntity(ctx, o.legalEntityId);
  const issues = validateAddress(o.addressJson);
  if (issues.length) throw new PostalError("VALIDATION", "Adresse d'organisme invalide", { issues });
  const prev = o.id ? await ctx.db.one<Organization>("postal_organizations", { id: o.id }) : null;
  const row: Organization = { ...o, id: o.id ?? uuid(), tenantId: ctx.scope.tenantId, addressJson: normalizeAddress(o.addressJson), version: (prev?.version ?? 0) + 1 };
  if (prev) await ctx.db.update("postal_organizations", { id: row.id }, row as unknown as Record<string, unknown>);
  else await ctx.db.insert("postal_organizations", row);
  await audit(ctx, { legalEntityId: o.legalEntityId, action: prev ? "organization.updated" : "organization.created", objectType: "organization", objectId: row.id, metadata: { version: row.version } });
  return row;
}

export async function upsertSenderProfile(ctx: Ctx, p: Omit<SenderProfile, "tenantId" | "id"> & { id?: string }): Promise<SenderProfile> {
  requirePermission(ctx, "postal.config.manage");
  requireEntity(ctx, p.legalEntityId, p.centerId);
  const issues = validateAddress({ ...p.postalAddressJson, company: p.postalAddressJson.company ?? p.businessName });
  if (issues.length) throw new PostalError("VALIDATION", "Adresse expéditeur invalide", { issues });
  const row: SenderProfile = { ...p, id: p.id ?? uuid(), tenantId: ctx.scope.tenantId };
  const prev = p.id ? await ctx.db.one("postal_sender_profiles", { id: p.id }) : null;
  if (prev) await ctx.db.update("postal_sender_profiles", { id: row.id }, row as unknown as Record<string, unknown>);
  else await ctx.db.insert("postal_sender_profiles", row);
  await audit(ctx, { legalEntityId: p.legalEntityId, action: "sender_profile.saved", objectType: "sender_profile", objectId: row.id });
  return row;
}

export async function setBudget(ctx: Ctx, b: Omit<Budget, "tenantId" | "id">): Promise<Budget> {
  requirePermission(ctx, "postal.config.manage");
  requireEntity(ctx, b.legalEntityId, b.centerId);
  if (!/^\d{4}-\d{2}$/.test(b.month) || b.limitCents < 0) throw new PostalError("VALIDATION", "Budget invalide");
  const row: Budget = { ...b, id: uuid(), tenantId: ctx.scope.tenantId };
  await ctx.db.insert("postal_budgets", row);
  await audit(ctx, { legalEntityId: b.legalEntityId, action: "budget.set", objectType: "budget", objectId: row.id, metadata: { month: b.month, limitCents: b.limitCents } });
  return row;
}

/**
 * Autorisation d'envoi sensible : réservée au DPO / responsable conformité, avec MFA (§13.2).
 * Exige la référence de l'analyse DPO et du DPA ; pour `hds_certified`, le certificat,
 * ses activités couvertes et sa date de fin de validité.
 */
export async function grantSensitiveAuthorization(
  ctx: Ctx,
  a: Omit<SensitiveAuthorization, "id" | "tenantId" | "validatedBy" | "validatedAt" | "revokedAt">,
): Promise<SensitiveAuthorization> {
  requirePermission(ctx, "postal.sensitive.authorize");
  requireEntity(ctx, a.legalEntityId);
  const ref = (x: string | null | undefined) => !!x && x.trim().length >= 3;
  if (!ref(a.documentRef)) throw new PostalError("VALIDATION", "Référence de l'analyse DPO requise");
  if (!ref(a.dpaRef)) throw new PostalError("VALIDATION", "Référence du contrat de sous-traitance (DPA art. 28) requise");
  if (a.provider === "manuscry") throw new PostalError("VALIDATION", "Aucune donnée sensible n'est autorisée vers Manuscry");
  if (a.qualification === "hds_certified") {
    if (!ref(a.certificateRef) || !ref(a.certificateScope) || !a.certificateExpiresAt) throw new PostalError("VALIDATION", "Certificat HDS : référence, activités couvertes et date d'expiration requises");
    if (a.certificateExpiresAt <= nowIso(ctx)) throw new PostalError("VALIDATION", "Certificat HDS expiré");
  }
  const t = await ctx.db.one<{ id: string; legalEntityId: string; provider: string }>("postal_templates", { id: a.templateId });
  if (!t || t.legalEntityId !== a.legalEntityId || t.provider !== a.provider) throw new PostalError("VALIDATION", "Modèle inconnu ou d'un autre prestataire");
  const row: SensitiveAuthorization = { ...a, id: uuid(), tenantId: ctx.scope.tenantId, validatedBy: ctx.scope.userId!, validatedAt: nowIso(ctx), revokedAt: null };
  await ctx.db.insert("postal_sensitive_authorizations", row);
  await audit(ctx, {
    legalEntityId: a.legalEntityId,
    action: "sensitive_authorization.granted",
    objectType: "template",
    objectId: a.templateId,
    metadata: { provider: a.provider, qualification: a.qualification, documentRef: a.documentRef, dpaRef: a.dpaRef, certificateRef: a.certificateRef, certificateExpiresAt: a.certificateExpiresAt, categories: a.allowedAttachmentCategoriesJson, recipients: a.allowedRecipientCategoriesJson },
  });
  return row;
}

export async function revokeSensitiveAuthorization(ctx: Ctx, id: string, reason: string): Promise<void> {
  requirePermission(ctx, "postal.sensitive.authorize");
  const a = await ctx.db.one<SensitiveAuthorization>("postal_sensitive_authorizations", { id });
  if (!a) throw new PostalError("NOT_FOUND", "Autorisation introuvable");
  requireEntity(ctx, a.legalEntityId);
  await ctx.db.update("postal_sensitive_authorizations", { id }, { revokedAt: nowIso(ctx) });
  await audit(ctx, { legalEntityId: a.legalEntityId, action: "sensitive_authorization.revoked", objectType: "template", objectId: a.templateId, metadata: { reason } });
}
