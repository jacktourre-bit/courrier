/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Les campagnes, en particulier l'automate des anniversaires. Chaque jour, il regarde les
 * anniversaires à venir et prépare une carte Manuscry pour les personnes qui ont donné leur
 * accord, une seule fois par an. Il respecte le délai d'expédition (5 jours en France, 10 à
 * l'étranger) et n'envoie jamais en retard.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { BirthdayRules, Campaign, CampaignRecipient, Dispatch, Purpose, RecipientAddress, Scope, Subject, TemplateVersion, Template } from "../domain/types.js";
import { isDomestic } from "../domain/address.js";
import { PostalError } from "../lib/errors.js";
import { addDays, isLeapYear, parisDate, uuid } from "../lib/util.js";
import { audit, nowIso, requireEntity, requirePermission, type Ctx, type Deps } from "./context.js";
import { createDispatch, requestApproval, transition } from "./dispatch-service.js";

export const DEFAULT_BIRTHDAY_RULES: BirthdayRules = {
  recurrenceOwner: null,
  feb29Policy: "feb28",
  allowMinors: false,
  requireExplicitOptIn: true,
  addressMaxAgeDays: 730,
  submitWindowDays: 30,
  birthdayDateMode: "next_occurrence",
};

/** Délais d'expédition documentés par Manuscry avant l'anniversaire. */
export const MANUSCRY_LEAD_DAYS = { domestic: 5, international: 10 } as const;
/** Marge de sécurité avant le délai prestataire. */
export const SAFETY_MARGIN_DAYS = 2;

// EN CLAIR : Crée une campagne liée à un modèle approuvé.
export async function createCampaign(ctx: Ctx, i: { legalEntityId: string; centerId: string | null; type: Campaign["type"]; templateVersionId: string; purpose: Purpose; rules?: Partial<BirthdayRules>; budgetCents?: number | null }): Promise<Campaign> {
  requirePermission(ctx, "postal.campaign.manage");
  requireEntity(ctx, i.legalEntityId, i.centerId);
  const v = await ctx.db.one<TemplateVersion>("postal_template_versions", { id: i.templateVersionId });
  const t = v ? await ctx.db.one<Template>("postal_templates", { id: v.templateId }) : null;
  if (!v || !t || t.legalEntityId !== i.legalEntityId) throw new PostalError("NOT_FOUND", "Modèle introuvable");
  if (t.purpose !== i.purpose) throw new PostalError("VALIDATION", "Finalité du modèle incompatible");
  const c: Campaign = {
    id: uuid(),
    tenantId: ctx.scope.tenantId,
    legalEntityId: i.legalEntityId,
    centerId: i.centerId,
    type: i.type,
    provider: t.provider,
    providerCampaignId: v.providerFieldsJson?.campaignId ?? null,
    templateVersionId: v.id,
    purpose: i.purpose,
    schedulingRulesJson: i.type === "birthday" ? { ...DEFAULT_BIRTHDAY_RULES, ...i.rules } : {},
    budgetCents: i.budgetCents ?? null,
    status: "draft",
    approvedBy: null,
    approvedAt: null,
    createdBy: ctx.scope.userId ?? "system",
  };
  await ctx.db.insert("postal_campaigns", c);
  await audit(ctx, { legalEntityId: c.legalEntityId, action: "campaign.created", objectType: "campaign", objectId: c.id });
  return c;
}

// EN CLAIR : Active la campagne (pas par son créateur). Pour les anniversaires, il faut d'abord
// décider qui gère la répétition annuelle : nous ou Manuscry.
export async function approveCampaign(ctx: Ctx, id: string): Promise<Campaign> {
  requirePermission(ctx, "postal.campaign.approve");
  const c = await ctx.db.one<Campaign>("postal_campaigns", { id });
  if (!c) throw new PostalError("NOT_FOUND", "Campagne introuvable");
  requireEntity(ctx, c.legalEntityId);
  if (c.createdBy === ctx.scope.userId) throw new PostalError("FORBIDDEN", "Le créateur ne peut pas approuver sa campagne");
  const v = await ctx.db.one<TemplateVersion>("postal_template_versions", { id: c.templateVersionId });
  if (v?.status !== "approved") throw new PostalError("APPROVAL_REQUIRED", "Version de modèle non approuvée");
  if (c.type === "birthday") {
    const r = c.schedulingRulesJson as BirthdayRules;
    // §5.2.8 : un seul acteur possède la récurrence ; réponse fournisseur requise avant activation.
    if (!r.recurrenceOwner) throw new PostalError("VALIDATION", "Propriétaire de la récurrence annuelle (saas | provider) à définir avant activation");
    if (r.submitWindowDays <= MANUSCRY_LEAD_DAYS.international + SAFETY_MARGIN_DAYS) throw new PostalError("VALIDATION", "Fenêtre de soumission trop courte");
  }
  const patch = { status: "active" as const, approvedBy: ctx.scope.userId, approvedAt: nowIso(ctx) };
  await ctx.db.update("postal_campaigns", { id }, patch);
  await audit(ctx, { legalEntityId: c.legalEntityId, action: "campaign.approved", objectType: "campaign", objectId: c.id });
  return { ...c, ...patch };
}

// EN CLAIR : Date de l'anniversaire pour une année donnée, avec le cas du 29 février (fêté le 28
// février ou le 1er mars les années non bissextiles).
/** Date d'anniversaire effective pour une année donnée (gestion du 29 février). */
export function occurrenceFor(birthDate: string, year: number, policy: BirthdayRules["feb29Policy"]): string {
  const md = birthDate.slice(5, 10);
  if (md === "02-29" && !isLeapYear(year)) return policy === "feb28" ? `${year}-02-28` : `${year}-03-01`;
  return `${year}-${md}`;
}

export interface BirthdayRunReport {
  campaigns: number;
  considered: number;
  dispatched: number;
  skipped: Record<string, number>;
}

// EN CLAIR : L'automate quotidien : trouve les anniversaires dans la fenêtre, élimine les cas exclus
// (opposition, mineur, décès, adresse trop ancienne, trop tard), et crée au plus une carte par
// personne et par an.
/**
 * Automate quotidien des anniversaires (§5.2). Pour chaque campagne active :
 * occurrences D telles que D - délai prestataire - marge ≥ aujourd'hui et D ≤ aujourd'hui + fenêtre.
 * Un événement manqué n'est JAMAIS converti en envoi immédiat.
 */
export async function runBirthdayScheduler(deps: Deps, opts: { tenantId?: string } = {}): Promise<BirthdayRunReport> {
  const report: BirthdayRunReport = { campaigns: 0, considered: 0, dispatched: 0, skipped: {} };
  const skip = (r: string) => (report.skipped[r] = (report.skipped[r] ?? 0) + 1);
  if (!deps.config.flags.POSTAL_MODULE_ENABLED || !deps.config.flags.BIRTHDAY_AUTOMATION_ENABLED || !deps.config.flags.MANUSCRY_ENABLED) return report;
  const sys = deps.db.withScope({ tenantId: opts.tenantId ?? "*", legalEntityIds: "*", centerIds: "*", userId: null });
  const campaigns = await sys.find<Campaign>("postal_campaigns", { type: "birthday", status: "active" });
  const today = parisDate(deps.clock.now());

  for (const c of campaigns) {
    const rules = { ...DEFAULT_BIRTHDAY_RULES, ...(c.schedulingRulesJson as Partial<BirthdayRules>) };
    if (!rules.recurrenceOwner || !c.approvedAt) {
      skip("campaign_misconfigured");
      continue;
    }
    report.campaigns++;
    const scope: Scope = { tenantId: c.tenantId, legalEntityIds: [c.legalEntityId], centerIds: "*", userId: null };
    const ctx: Ctx = { ...deps, scope, db: deps.db.withScope(scope), permissions: new Set(["postal.read", "postal.draft"]) };

    // Dates cibles de la fenêtre (le jour le plus proche possible = aujourd'hui + délai domestique + marge)
    const firstOffset = MANUSCRY_LEAD_DAYS.domestic + SAFETY_MARGIN_DAYS;
    const targets: string[] = [];
    for (let k = firstOffset; k <= rules.submitWindowDays; k++) targets.push(addDays(today, k));
    const mds = new Set<string>();
    for (const t of targets) {
      mds.add(t.slice(5));
      if (t.slice(5) === (rules.feb29Policy === "feb28" ? "02-28" : "03-01") && !isLeapYear(Number(t.slice(0, 4)))) mds.add("02-29");
    }
    const subjects = await ctx.db.find<Subject>("postal_subjects", { legalEntityId: c.legalEntityId, birthMd: { in: [...mds] }, deceased: false, archived: false, ...(c.centerId ? { centerId: c.centerId } : {}) });

    for (const s of subjects) {
      if (!s.birthDate || !s.birthDateReliable) {
        skip("birth_date_unreliable");
        continue;
      }
      const year = Number(today.slice(0, 4));
      // Occurrence la plus proche à venir
      let occ = occurrenceFor(s.birthDate, year, rules.feb29Policy);
      if (occ < today) occ = occurrenceFor(s.birthDate, year + 1, rules.feb29Policy);
      if (!targets.includes(occ)) continue;
      report.considered++;

      const addr = (await ctx.db.find<RecipientAddress>("postal_recipient_addresses", { subjectType: s.type, subjectId: s.id, legalEntityId: c.legalEntityId, validityStatus: "valid" }, { orderBy: [["version", "desc"]], limit: 1 }))[0];
      const lead = addr && !isDomestic(addr.addressJson) ? MANUSCRY_LEAD_DAYS.international : MANUSCRY_LEAD_DAYS.domestic;
      const occYear = Number(occ.slice(0, 4));
      const providerOwns = rules.recurrenceOwner === "provider";
      const eventKey = providerOwns ? "birthday:enrolled" : `birthday:${occYear}`;
      const recYear = providerOwns ? 0 : occYear;

      const rec: CampaignRecipient = {
        id: uuid(), tenantId: c.tenantId, legalEntityId: c.legalEntityId, campaignId: c.id, subjectType: s.type, subjectId: s.id,
        eventKey, year: recYear, eligibilitySnapshotJson: { occurrence: occ, leadDays: lead, evaluatedAt: nowIso(deps) }, dispatchId: null, outcome: "queued", reason: null,
      };
      const fresh = await ctx.db.insertIgnore("postal_campaign_recipients", rec);
      if (!fresh) {
        const prev = await ctx.db.one<CampaignRecipient>("postal_campaign_recipients", { campaignId: c.id, eventKey, year: recYear, subjectId: s.id });
        // Seuls les refus de conformité transitoires sont réévalués tant que la fenêtre court.
        if (!prev || prev.outcome !== "skipped" || prev.reason === "late" || prev.reason === "opposition") {
          skip("already_processed");
          continue;
        }
        rec.id = prev.id;
      }
      const setOutcome = (outcome: CampaignRecipient["outcome"], reason: string | null, dispatchId: string | null = null) =>
        ctx.db.update("postal_campaign_recipients", { id: rec.id }, { outcome, reason, dispatchId });

      if (addDays(occ, -(lead + SAFETY_MARGIN_DAYS)) < today) {
        await setOutcome("skipped", "late");
        skip("late");
        continue;
      }
      if (!addr) {
        await setOutcome("skipped", "no_valid_address");
        skip("no_valid_address");
        continue;
      }
      try {
        const d = await createDispatch(ctx, {
          legalEntityId: c.legalEntityId,
          centerId: s.centerId,
          sourceType: "campaign",
          sourceId: c.id,
          subject: { type: s.type, id: s.id },
          recipient: { addressId: addr.id },
          purpose: "relationship",
          templateVersionId: c.templateVersionId,
          postageClass: "handwritten",
          eventKey,
          idempotencyKey: `bday:${c.id}:${s.id}:${recYear}`,
          campaignId: c.id,
          automated: true,
          requiredPreference: "birthday",
          birthdayDate: rules.birthdayDateMode === "birth_date" ? s.birthDate : occ,
        });
        // Aperçu de campagne validé à l'approbation du modèle : pas d'aperçu unitaire automatique.
        const previewed: Dispatch = d.status === "READY_FOR_PREVIEW" ? await transition(ctx, d, "PREVIEWED") : d;
        await requestApproval(ctx, previewed.id);
        await setOutcome("dispatched", null, d.id);
        report.dispatched++;
      } catch (e) {
        const code = e instanceof PostalError ? ((e.details?.blockers as { code: string }[] | undefined)?.map((b) => b.code).join(",") ?? e.code) : "error";
        await setOutcome("skipped", code.slice(0, 120));
        skip(code.split(",")[0] ?? "error");
        deps.logger.warn("birthday.skipped", { campaignId: c.id, code });
      }
    }
  }
  return report;
}

// EN CLAIR : Estime combien de personnes recevraient une carte et le coût, sans rien envoyer.
/** Simulation de campagne : effectif éligible et coût estimé, sans aucun appel prestataire. */
export async function simulateBirthdayCampaign(ctx: Ctx, campaignId: string, unitCostTtcCents: number): Promise<{ eligibleNext365: number; estimatedCents: number }> {
  requirePermission(ctx, "postal.campaign.manage");
  const c = await ctx.db.one<Campaign>("postal_campaigns", { id: campaignId });
  if (!c) throw new PostalError("NOT_FOUND", "Campagne introuvable");
  requireEntity(ctx, c.legalEntityId);
  const subjects = await ctx.db.find<Subject>("postal_subjects", { legalEntityId: c.legalEntityId, deceased: false, archived: false, birthMd: { isNull: false } });
  let n = 0;
  for (const s of subjects) {
    const prefs = await ctx.db.find<{ purpose: string; allowed: boolean; updatedAt: string }>("postal_contact_preferences", { subjectType: s.type, subjectId: s.id, legalEntityId: c.legalEntityId, purpose: "birthday" }, { orderBy: [["updatedAt", "desc"], ["allowed", "asc"]], limit: 1 });
    if (prefs[0]?.allowed && !s.deceased) n++;
  }
  return { eligibleNext365: n, estimatedCents: n * unitCostTtcCents };
}
