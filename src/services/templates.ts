import type { Purpose, ProviderName, Sensitivity, Template, TemplateBlockContent, TemplateVersion } from "../domain/types.js";
import { validateTemplateFields, extractPlaceholders, detectHealthTerms, RELATIONAL_PURPOSES, fieldCategory } from "../domain/merge-fields.js";
import { PostalError } from "../lib/errors.js";
import { canonicalHash, uuid } from "../lib/util.js";
import { ManuscryAdapter } from "../providers/manuscry/adapter.js";
import { audit, nowIso, requireEntity, requirePermission, resolveConnection, type Ctx } from "./context.js";

export interface NewTemplateInput {
  legalEntityId: string;
  type: Template["type"];
  provider: ProviderName;
  purpose: Purpose;
  title: string;
}

export async function createTemplate(ctx: Ctx, i: NewTemplateInput): Promise<Template> {
  requirePermission(ctx, "postal.templates.manage");
  requireEntity(ctx, i.legalEntityId);
  if (i.type === "handwritten" && i.provider !== "manuscry") throw new PostalError("VALIDATION", "Modèle manuscrit => Manuscry");
  if (i.type === "formal" && i.provider !== "servicepostal") throw new PostalError("VALIDATION", "Modèle formel => Service Postal");
  if (i.type === "handwritten" && !RELATIONAL_PURPOSES.includes(i.purpose)) throw new PostalError("VALIDATION", "Manuscrit réservé au relationnel/marketing");
  const t: Template = { id: uuid(), tenantId: ctx.scope.tenantId, legalEntityId: i.legalEntityId, type: i.type, provider: i.provider, purpose: i.purpose, title: i.title.slice(0, 200), status: "draft", currentVersionId: null };
  await ctx.db.insert("postal_templates", t);
  await audit(ctx, { legalEntityId: i.legalEntityId, action: "template.created", objectType: "template", objectId: t.id });
  return t;
}

export interface NewVersionInput {
  allowedMergeFields: string[];
  content: TemplateBlockContent;
  declaredSensitivity: Sensitivity;
  provider?: { campaignId: string; fieldMap: Record<string, string>; staticAiContext?: string | null };
}

export async function addTemplateVersion(ctx: Ctx, templateId: string, i: NewVersionInput): Promise<TemplateVersion> {
  requirePermission(ctx, "postal.templates.manage");
  const t = await ctx.db.one<Template>("postal_templates", { id: templateId });
  if (!t) throw new PostalError("NOT_FOUND", "Modèle introuvable");
  requireEntity(ctx, t.legalEntityId);
  const allText = [i.content.body, i.content.subject ?? "", i.content.closing ?? "", ...(i.content.references ?? [])].join("\n");
  validateTemplateFields(t.purpose, i.allowedMergeFields, allText);
  if (RELATIONAL_PURPOSES.includes(t.purpose)) {
    const hits = detectHealthTerms(`${allText}\n${i.provider?.staticAiContext ?? ""}`);
    if (hits.length) throw new PostalError("COMPLIANCE_BLOCKED", `Termes santé interdits dans un modèle relationnel : ${hits.join(", ")}`);
    if (i.declaredSensitivity === "health" || i.declaredSensitivity === "personal_sensitive") throw new PostalError("COMPLIANCE_BLOCKED", "Modèle relationnel sensible interdit");
  }
  if (t.provider === "manuscry") {
    if (!i.provider?.campaignId) throw new PostalError("VALIDATION", "campaign_id Manuscry requis");
    // Les champs de la campagne sont lus via l'API, jamais supposés (§4.4, test 27).
    const { conn, adapter } = await resolveConnection(ctx, t.legalEntityId, "manuscry");
    const s = await (adapter as ManuscryAdapter).getCampaignSettings(conn, i.provider.campaignId);
    if (!s.ok) throw new PostalError("PROVIDER_ERROR", `Lecture de la campagne impossible : ${s.message}`);
    const keys = ManuscryAdapter.letterVariableKeys(s.value);
    const required = s.value.fields.filter((f) => f.required && keys.includes(f.key)).map((f) => f.key);
    const unknown = Object.keys(i.provider.fieldMap).filter((k) => !keys.includes(k));
    if (unknown.length) throw new PostalError("VALIDATION", `Variables absentes de la campagne : ${unknown.join(", ")}`);
    const missing = required.filter((k) => !(k in i.provider!.fieldMap));
    if (missing.length) throw new PostalError("VALIDATION", `Variables de campagne requises non mappées : ${missing.join(", ")}`);
    for (const reg of Object.values(i.provider.fieldMap)) {
      if (!i.allowedMergeFields.includes(reg)) throw new PostalError("VALIDATION", `Champ ${reg} mappé mais non autorisé dans le modèle`);
      const c = fieldCategory(reg);
      if (c === "health" || c === "sensitive") throw new PostalError("COMPLIANCE_BLOCKED", `Champ ${reg} interdit vers Manuscry`);
    }
    if (s.value.campaign.type === "birthday" && t.purpose !== "relationship") throw new PostalError("VALIDATION", "Campagne anniversaire => finalité relationnelle");
  }
  const versions = await ctx.db.find<TemplateVersion>("postal_template_versions", { templateId }, { orderBy: [["version", "desc"]], limit: 1 });
  const v: TemplateVersion = {
    id: uuid(),
    tenantId: t.tenantId,
    legalEntityId: t.legalEntityId,
    templateId,
    version: (versions[0]?.version ?? 0) + 1,
    allowedMergeFieldsJson: [...new Set(i.allowedMergeFields)],
    contentJson: i.content,
    providerFieldsJson: i.provider ? { campaignId: i.provider.campaignId, fieldMap: i.provider.fieldMap, staticAiContext: i.provider.staticAiContext ?? null } : null,
    declaredSensitivity: i.declaredSensitivity,
    status: "draft",
    approvalsJson: [],
    contentHash: canonicalHash({ content: i.content, fields: i.allowedMergeFields, provider: i.provider ?? null }),
    createdBy: ctx.scope.userId ?? "system",
    createdAt: nowIso(ctx),
  };
  await ctx.db.insert("postal_template_versions", v);
  await audit(ctx, { legalEntityId: t.legalEntityId, action: "template.version_created", objectType: "template_version", objectId: v.id, metadata: { version: v.version, placeholders: extractPlaceholders(i.content.body) } });
  return v;
}

/** Approbation d'une version (auteur exclu) ; l'ancienne version approuvée est archivée. */
export async function approveTemplateVersion(ctx: Ctx, versionId: string): Promise<TemplateVersion> {
  requirePermission(ctx, "postal.templates.approve");
  const v = await ctx.db.one<TemplateVersion>("postal_template_versions", { id: versionId });
  if (!v) throw new PostalError("NOT_FOUND", "Version introuvable");
  requireEntity(ctx, v.legalEntityId);
  if (v.status !== "draft") throw new PostalError("INVALID_TRANSITION", "Version déjà traitée");
  if (v.createdBy === ctx.scope.userId) throw new PostalError("FORBIDDEN", "L'auteur ne peut pas approuver sa propre version");
  const t = (await ctx.db.one<Template>("postal_templates", { id: v.templateId }))!;
  if (t.currentVersionId) await ctx.db.update("postal_template_versions", { id: t.currentVersionId, status: "approved" }, { status: "archived" });
  const approvals = [...v.approvalsJson, { userId: ctx.scope.userId!, at: nowIso(ctx) }];
  await ctx.db.update("postal_template_versions", { id: v.id }, { status: "approved", approvalsJson: approvals });
  await ctx.db.update("postal_templates", { id: t.id }, { status: "approved", currentVersionId: v.id });
  await audit(ctx, { legalEntityId: v.legalEntityId, action: "template.version_approved", objectType: "template_version", objectId: v.id });
  return { ...v, status: "approved", approvalsJson: approvals };
}

/** Retour arrière : ré-active une version archivée (nouvelle approbation tracée). */
export async function rollbackTemplate(ctx: Ctx, templateId: string, versionId: string): Promise<void> {
  requirePermission(ctx, "postal.templates.approve");
  const t = await ctx.db.one<Template>("postal_templates", { id: templateId });
  const v = await ctx.db.one<TemplateVersion>("postal_template_versions", { id: versionId, templateId });
  if (!t || !v || v.status !== "archived") throw new PostalError("VALIDATION", "Version archivée requise");
  requireEntity(ctx, t.legalEntityId);
  if (t.currentVersionId) await ctx.db.update("postal_template_versions", { id: t.currentVersionId }, { status: "archived" });
  await ctx.db.update("postal_template_versions", { id: v.id }, { status: "approved", approvalsJson: [...v.approvalsJson, { userId: ctx.scope.userId!, at: nowIso(ctx) }] });
  await ctx.db.update("postal_templates", { id: t.id }, { currentVersionId: v.id, status: "approved" });
  await audit(ctx, { legalEntityId: t.legalEntityId, action: "template.rollback", objectType: "template", objectId: t.id, metadata: { versionId } });
}
