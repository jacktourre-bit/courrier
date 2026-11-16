import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Approval, Dispatch, Evidence, PostalEvent, ProviderConnection, ProviderName, Template, TemplateVersion, Campaign } from "../domain/types.js";
import { PostalError } from "../lib/errors.js";
import { validateUpload } from "../lib/files.js";
import { scopeFor, type Authenticator } from "./auth.js";
import * as S from "./schemas.js";
import { audit, nowIso, readAsset, requireEntity, requireModule, requirePermission, storeAsset, type Ctx, type Deps, type HumanTask } from "../services/context.js";
import {
  approveDispatch,
  cancelDispatch,
  createDispatch,
  enqueue,
  evidenceExpected,
  exportDocument,
  getDispatch,
  modifyDispatch,
  previewDispatch,
  rejectDispatch,
  requestApproval,
  requiredSteps,
} from "../services/dispatch-service.js";
import { addTemplateVersion, approveTemplateVersion, createTemplate, rollbackTemplate } from "../services/templates.js";
import { approveCampaign, createCampaign, simulateBirthdayCampaign } from "../services/campaigns.js";
import { setPreference } from "../services/preferences.js";
import { addRecipientAddress, createConnection, grantSensitiveAuthorization, setBudget, testConnection, upsertOrganization, upsertSenderProfile, upsertSubject } from "../services/admin.js";
import { ingestWebhook, MAX_WEBHOOK_BYTES } from "../services/webhooks.js";

type Env = { Variables: { traceId: string; ctx: Ctx } };

export interface ApiOptions {
  deps: Deps;
  auth: Authenticator;
  /** Requêtes par minute et par utilisateur. */
  rateLimitPerMinute?: number;
}

/** Limiteur simple en mémoire (remplaçable par Redis en multi-instance). */
function limiter(perMinute: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  };
}

const parse = <T extends z.ZodType>(schema: T, data: unknown): z.infer<T> => {
  const r = schema.safeParse(data);
  if (!r.success) throw new PostalError("VALIDATION", "Requête invalide", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })) });
  return r.data;
};

async function json(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new PostalError("VALIDATION", "JSON invalide");
  }
}

/** Vue publique d'un envoi : pas de clé de stockage ni d'URL de document. */
function view(d: Dispatch) {
  const { mergeValuesJson: _m, ...rest } = d;
  return rest;
}

export function createApi(o: ApiOptions) {
  const { deps } = o;
  const app = new Hono<Env>();
  const allow = limiter(o.rateLimitPerMinute ?? 120);
  const allowWebhook = limiter(600);

  app.use("*", async (c, next) => {
    const t = c.req.header("x-request-id");
    c.set("traceId", t && /^[A-Za-z0-9-]{8,64}$/.test(t) ? t : randomUUID());
    await next();
    c.header("x-request-id", c.get("traceId"));
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
  });

  app.onError((err, c) => {
    if (err instanceof PostalError) return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null }, trace_id: c.get("traceId") }, err.httpStatus as 400);
    deps.logger.error("api.unhandled", { traceId: c.get("traceId"), name: (err as Error)?.name });
    return c.json({ error: { code: "INTERNAL", message: "Erreur interne" }, trace_id: c.get("traceId") }, 500);
  });

  // ------------------------------------------------------------ Webhooks
  for (const provider of ["manuscry", "servicepostal"] as ProviderName[]) {
    app.post(`/api/postal/webhooks/${provider}/:token`, bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
      const token = c.req.param("token");
      if (!allowWebhook(`${provider}:${token.slice(0, 12)}`)) return c.json({ error: "rate_limited" }, 429);
      const raw = await c.req.text();
      const r = await ingestWebhook(deps, provider, token, raw);
      return c.json({ result: r.result }, r.httpStatus as 200);
    });
  }

  // ------------------------------------------------- Authentification + scope
  const api = new Hono<Env>();
  api.use("*", bodyLimit({ maxSize: 25 * 1024 * 1024, onError: (c) => c.json({ error: { code: "VALIDATION", message: "Corps trop volumineux" } }, 413) }));
  api.use("*", async (c, next) => {
    requireModule(deps);
    // Anti-CSRF : si l'hôte utilise des cookies, double-soumission obligatoire.
    if (c.req.header("cookie") && !c.req.header("authorization") && c.req.method !== "GET") {
      const cookie = /(?:^|;\s*)postal_csrf=([^;]+)/.exec(c.req.header("cookie") ?? "")?.[1];
      if (!cookie || cookie !== c.req.header("x-csrf-token")) throw new PostalError("FORBIDDEN", "Jeton CSRF invalide");
    }
    const p = await o.auth.authenticate(c.req.raw.headers);
    if (!p) return c.json({ error: { code: "UNAUTHENTICATED", message: "Authentification requise" } }, 401);
    if (!allow(p.userId)) throw new PostalError("RATE_LIMITED", "Trop de requêtes");
    const { scope, permissions } = scopeFor(p, c.req.header("x-legal-entity-id") ?? null);
    c.set("ctx", { ...deps, scope, permissions, db: deps.db.withScope(scope) });
    await next();
  });

  const ctxOf = (c: Context<Env>) => c.get("ctx");
  const idemKey = (c: Context<Env>) => {
    const k = c.req.header("idempotency-key");
    if (!k || !/^[A-Za-z0-9_-]{16,100}$/.test(k)) throw new PostalError("VALIDATION", "En-tête Idempotency-Key requis (16-100 caractères)");
    return k;
  };

  // Connexions prestataires
  api.get("/providers", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.read");
    const rows = await ctx.db.find<ProviderConnection>("postal_provider_connections", {});
    return c.json({ data: rows.map(({ credentialsSecretRef: _s, webhookTokenHash: _w, ...r }) => r) });
  });
  api.post("/providers", async (c) => {
    const ctx = ctxOf(c);
    const b = parse(S.ConnectionSchema, await json(c));
    const r = await createConnection(ctx, { legalEntityId: b.legal_entity_id, provider: b.provider, environment: b.environment, credentialsSecretRef: b.credentials_secret_ref, settings: b.settings });
    const { credentialsSecretRef: _s, webhookTokenHash: _w, ...conn } = r.connection;
    // Le jeton n'est renvoyé qu'une fois : à configurer côté prestataire.
    return c.json({ data: conn, webhook_path: `/api/postal/webhooks/${conn.provider}/${r.webhookToken}` }, 201);
  });
  api.post("/providers/:id/test", async (c) => c.json({ data: await testConnection(ctxOf(c), c.req.param("id")) }));

  // Modèles
  api.get("/templates", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.read");
    return c.json({ data: await ctx.db.find<Template>("postal_templates", { status: { ne: "archived" } }) });
  });
  api.post("/templates", async (c) => {
    const b = parse(S.CreateTemplateSchema, await json(c));
    return c.json({ data: await createTemplate(ctxOf(c), { legalEntityId: b.legal_entity_id, type: b.type, provider: b.provider, purpose: b.purpose, title: b.title }) }, 201);
  });
  api.get("/templates/:id/versions", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.read");
    return c.json({ data: await ctx.db.find<TemplateVersion>("postal_template_versions", { templateId: c.req.param("id") }, { orderBy: [["version", "desc"]] }) });
  });
  api.post("/templates/:id/versions", async (c) => {
    const b = parse(S.TemplateVersionSchema, await json(c));
    const v = await addTemplateVersion(ctxOf(c), c.req.param("id"), {
      allowedMergeFields: b.allowed_merge_fields,
      content: b.content,
      declaredSensitivity: b.declared_sensitivity,
      provider: b.provider ? { campaignId: b.provider.campaign_id, fieldMap: b.provider.field_map, staticAiContext: b.provider.static_ai_context ?? null } : undefined,
    });
    return c.json({ data: v }, 201);
  });
  api.post("/template-versions/:id/approve", async (c) => c.json({ data: await approveTemplateVersion(ctxOf(c), c.req.param("id")) }));
  api.post("/templates/:id/rollback/:versionId", async (c) => {
    await rollbackTemplate(ctxOf(c), c.req.param("id"), c.req.param("versionId"));
    return c.json({ ok: true });
  });

  // Envois
  api.post("/dispatches", async (c) => {
    const ctx = ctxOf(c);
    const b = parse(S.CreateDispatchSchema, await json(c));
    const d = await createDispatch(ctx, {
      legalEntityId: b.legal_entity_id,
      centerId: b.center_id,
      sourceType: b.source_type,
      sourceId: b.source_id ?? null,
      subject: b.subject,
      recipient: "address_id" in b.recipient ? { addressId: b.recipient.address_id } : { organizationId: b.recipient.organization_id },
      purpose: b.purpose,
      templateVersionId: b.template_version_id,
      postageClass: b.postage_class,
      options: b.options,
      scheduledFor: b.scheduled_for ?? null,
      eventKey: b.event_key ?? null,
      attachments: b.attachments?.map((a) => ({ assetId: a.asset_id, filename: a.filename, category: a.category, sensitivity: a.sensitivity })),
      idempotencyKey: `${ctx.scope.userId}:${idemKey(c)}`,
    });
    return c.json({ data: view(d) }, 201);
  });
  api.get("/dispatches", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.read");
    const q = parse(S.ListSchema, c.req.query());
    const rows = await ctx.db.find<Dispatch>("postal_dispatches", q.status ? { status: q.status } : {}, { orderBy: [["createdAt", "desc"]], limit: q.per_page, offset: (q.page - 1) * q.per_page });
    const visible = rows.filter((d) => !d.centerId || ctx.scope.centerIds === "*" || ctx.scope.centerIds?.includes(d.centerId));
    return c.json({ data: visible.map(view), page: q.page, per_page: q.per_page });
  });
  api.get("/dispatches/:id", async (c) => {
    const ctx = ctxOf(c);
    const d = await getDispatch(ctx, c.req.param("id"));
    const [events, approvals, evidence] = await Promise.all([
      ctx.db.find<PostalEvent>("postal_events", { dispatchId: d.id }, { orderBy: [["occurredAt", "asc"]] }),
      ctx.db.find<Approval>("postal_approvals", { dispatchId: d.id }, { orderBy: [["timestamp", "asc"]] }),
      ctx.db.find<Evidence>("postal_evidence", { dispatchId: d.id }),
    ]);
    return c.json({
      data: view(d),
      required_steps: requiredSteps(d).map((s) => s.step),
      approvals: approvals.map(({ approvalHash: _h, ...a }) => a),
      events: events.map(({ payloadDigest: _p, ...e }) => e),
      evidence: evidence.map((e) => ({ id: e.id, kind: e.kind, sha256: e.sha256, obtained_at: e.obtainedAt })),
      evidence_expected: evidenceExpected(d),
      evidence_missing: evidenceExpected(d).filter((k) => k !== "tracking" && !evidence.some((e) => e.kind === k)),
    });
  });
  api.patch("/dispatches/:id", async (c) => {
    const b = parse(S.ModifyDispatchSchema, await json(c));
    return c.json({ data: view(await modifyDispatch(ctxOf(c), c.req.param("id"), { scheduledFor: b.scheduled_for, postageClass: b.postage_class, options: b.options, recipientAddressId: b.recipient_address_id })) });
  });
  api.post("/dispatches/:id/preview", async (c) => c.json({ data: view(await previewDispatch(ctxOf(c), c.req.param("id"))) }));
  api.get("/dispatches/:id/quote", async (c) => {
    const d = await getDispatch(ctxOf(c), c.req.param("id"));
    return c.json({ data: { ht_cents: d.quoteHtCents, ttc_cents: d.quoteTtcCents, postage_ht_cents: d.quotePostageCents, service_ht_cents: d.quoteServiceCents, currency: d.currency, pages: d.pageCount } });
  });
  /** « Soumettre » = entrer dans le circuit d'approbation ; l'émission vers le prestataire suit l'approbation finale. */
  api.post("/dispatches/:id/submit", async (c) => c.json({ data: view(await requestApproval(ctxOf(c), c.req.param("id"))) }));
  api.post("/dispatches/:id/approve", async (c) => {
    const b = parse(S.ApproveSchema, await json(c).catch(() => ({})));
    return c.json({ data: view(await approveDispatch(ctxOf(c), c.req.param("id"), { reason: b.reason ?? null, budgetOverride: b.budget_override })) });
  });
  api.post("/dispatches/:id/reject", async (c) => c.json({ data: view(await rejectDispatch(ctxOf(c), c.req.param("id"), parse(S.ReasonSchema, await json(c)).reason)) }));
  api.post("/dispatches/:id/cancel", async (c) => c.json({ data: view(await cancelDispatch(ctxOf(c), c.req.param("id"), parse(S.ReasonSchema, await json(c)).reason)) }));
  api.post("/dispatches/:id/provider-validation", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.approve");
    const b = parse(S.ProviderDecisionSchema, await json(c));
    const d = await getDispatch(ctx, c.req.param("id"));
    if (d.provider !== "manuscry" || !d.providerLetterId) throw new PostalError("VALIDATION", "Aucune lettre Manuscry en attente de validation");
    await enqueue(ctx, d, "PROVIDER_VALIDATE", { decision: b.decision, userId: ctx.scope.userId }, nowIso(ctx));
    await audit(ctx, { legalEntityId: d.legalEntityId, action: `provider_letter.${b.decision}`, objectType: "dispatch", objectId: d.id });
    return c.json({ ok: true }, 202);
  });
  // Documents : téléchargement contrôlé côté serveur (jamais d'URL prestataire exposée).
  api.get("/dispatches/:id/document", async (c) => {
    const ctx = ctxOf(c);
    const d = await getDispatch(ctx, c.req.param("id"));
    const which = c.req.query("which") === "preview" ? d.previewAssetId : d.documentAssetId;
    if (!which) throw new PostalError("NOT_FOUND", "Document indisponible");
    if ((d.sensitivity === "health" || d.sensitivity === "personal_sensitive") && !ctx.permissions.has("postal.evidence.read") && !ctx.permissions.has("postal.export")) throw new PostalError("FORBIDDEN", "Document sensible");
    const { bytes, asset } = await readAsset(ctx, which);
    await audit(ctx, { legalEntityId: d.legalEntityId, action: "document.viewed", objectType: "dispatch", objectId: d.id, metadata: { kind: asset.kind } });
    return new Response(bytes, { headers: { "content-type": asset.mimeType, "content-disposition": `inline; filename="${d.reference}.pdf"`, "cache-control": "no-store" } });
  });
  api.get("/dispatches/:id/export", async (c) => {
    const { bytes, filename } = await exportDocument(ctxOf(c), c.req.param("id"));
    return new Response(bytes, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });
  });
  api.get("/dispatches/:id/evidence/:evidenceId", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.evidence.read");
    const d = await getDispatch(ctx, c.req.param("id"));
    const e = await ctx.db.one<Evidence>("postal_evidence", { id: c.req.param("evidenceId"), dispatchId: d.id });
    if (!e) throw new PostalError("NOT_FOUND", "Preuve introuvable");
    const { bytes, asset } = await readAsset(ctx, e.securedAssetId);
    await audit(ctx, { legalEntityId: d.legalEntityId, action: "evidence.viewed", objectType: "dispatch", objectId: d.id, metadata: { kind: e.kind } });
    return new Response(bytes, { headers: { "content-type": asset.mimeType, "content-disposition": `attachment; filename="${d.reference}-${e.kind}"`, "x-sha256": e.sha256 } });
  });
  api.get("/subjects/:type/:id/dispatches", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.read");
    const rows = await ctx.db.find<Dispatch>("postal_dispatches", { subjectType: c.req.param("type"), subjectId: c.req.param("id") }, { orderBy: [["createdAt", "desc"]], limit: 200 });
    return c.json({ data: rows.map(view) });
  });

  // Pièces jointes
  api.post("/assets", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.draft");
    const b = parse(S.AssetUploadSchema, await json(c));
    requireEntity(ctx, b.legal_entity_id);
    const bytes = new Uint8Array(Buffer.from(b.content_base64, "base64"));
    const v = await validateUpload(bytes, b.mime_type, ctx.scanner);
    const a = await storeAsset(ctx, { tenantId: ctx.scope.tenantId, legalEntityId: b.legal_entity_id, bytes, mimeType: v.mime, sensitivity: b.sensitivity, kind: "attachment" });
    await audit(ctx, { legalEntityId: b.legal_entity_id, action: "asset.uploaded", objectType: "asset", objectId: a.id, metadata: { mime: v.mime, pages: v.pageCount, av: v.engine } });
    return c.json({ data: { id: a.id, sha256: a.sha256, mime_type: a.mimeType, size_bytes: a.sizeBytes, page_count: v.pageCount } }, 201);
  });

  // Campagnes
  api.post("/campaigns", async (c) => {
    const b = parse(S.CampaignSchema, await json(c));
    return c.json({ data: await createCampaign(ctxOf(c), { legalEntityId: b.legal_entity_id, centerId: b.center_id, type: b.type, templateVersionId: b.template_version_id, purpose: b.purpose, rules: b.rules as never, budgetCents: b.budget_cents ?? null }) }, 201);
  });
  api.get("/campaigns", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.read");
    return c.json({ data: await ctx.db.find<Campaign>("postal_campaigns", {}) });
  });
  api.post("/campaigns/:id/simulate", async (c) => {
    const ctx = ctxOf(c);
    const conn = (await ctx.db.find<ProviderConnection>("postal_provider_connections", { provider: "manuscry" }))[0];
    return c.json({ data: await simulateBirthdayCampaign(ctx, c.req.param("id"), (conn?.settingsJson.unitCostTtcCents as number | undefined) ?? 0) });
  });
  api.post("/campaigns/:id/approve", async (c) => c.json({ data: await approveCampaign(ctxOf(c), c.req.param("id")) }));

  // Préférences, annuaire, configuration
  api.post("/preferences", async (c) => {
    const b = parse(S.PreferenceSchema, await json(c));
    return c.json({ data: await setPreference(ctxOf(c), { legalEntityId: b.legal_entity_id, subjectType: b.subject_type, subjectId: b.subject_id, purpose: b.purpose, allowed: b.allowed, legalBasis: b.legal_basis, evidenceId: b.evidence_id, source: b.source }) }, 201);
  });
  api.post("/subjects", async (c) => {
    const b = parse(S.SubjectSchema, await json(c));
    return c.json({
      data: await upsertSubject(ctxOf(c), {
        id: b.id, legalEntityId: b.legal_entity_id, centerId: b.center_id, type: b.type, civility: b.civility, firstName: b.first_name, lastName: b.last_name, company: b.company,
        birthDate: b.birth_date, birthDateReliable: b.birth_date_reliable, deceased: b.deceased, archived: b.archived, litigation: b.litigation, hasLegalRepresentative: b.has_legal_representative, publicReference: b.public_reference,
      } as never),
    }, 201);
  });
  api.post("/addresses", async (c) => {
    const b = parse(S.AddressCreateSchema, await json(c));
    return c.json({ data: await addRecipientAddress(ctxOf(c), { legalEntityId: b.legal_entity_id, subjectType: b.subject_type, subjectId: b.subject_id, address: b.address as never, verifiedAt: b.verified_at ?? null, verificationSource: b.verification_source ?? null }) }, 201);
  });
  api.get("/organizations", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.read");
    return c.json({ data: await ctx.db.find("postal_organizations", { active: true }) });
  });
  api.post("/organizations", async (c) => {
    const b = parse(S.OrganizationSchema, await json(c));
    return c.json({
      data: await upsertOrganization(ctxOf(c), {
        id: b.id, legalEntityId: b.legal_entity_id, centerId: b.center_id, category: b.category, name: b.name, branch: b.branch, service: b.service, addressJson: b.address as never,
        channelPolicy: b.channel_policy, verifiedAt: b.verified_at, source: b.source, active: b.active,
      }),
    }, 201);
  });
  api.post("/sender-profiles", async (c) => {
    const b = parse(S.SenderProfileSchema, await json(c));
    return c.json({
      data: await upsertSenderProfile(ctxOf(c), {
        id: b.id, legalEntityId: b.legal_entity_id, centerId: b.center_id, businessName: b.business_name, envelopeDisplayName: b.envelope_display_name, postalAddressJson: b.address as never,
        contact: b.contact, signatureAssetId: null, defaultProvider: b.default_provider, active: b.active,
      }),
    }, 201);
  });
  api.post("/budgets", async (c) => {
    const b = parse(S.BudgetSchema, await json(c));
    return c.json({ data: await setBudget(ctxOf(c), { legalEntityId: b.legal_entity_id, centerId: b.center_id, campaignId: b.campaign_id, month: b.month, limitCents: b.limit_cents, alertThresholds: b.alert_thresholds ?? [0.5, 0.8, 1] }) }, 201);
  });
  api.post("/sensitive-authorizations", async (c) => {
    const b = parse(S.SensitiveAuthSchema, await json(c));
    return c.json({ data: await grantSensitiveAuthorization(ctxOf(c), { legalEntityId: b.legal_entity_id, provider: b.provider, templateId: b.template_id, documentRef: b.document_ref, expiresAt: b.expires_at }) }, 201);
  });

  // Tâches humaines (« À valider », incidents)
  api.get("/tasks", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.read");
    return c.json({ data: await ctx.db.find<HumanTask>("postal_human_tasks", { status: "open" }, { orderBy: [["createdAt", "desc"]], limit: 200 }) });
  });
  api.post("/tasks/:id/close", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.approve");
    const n = await ctx.db.update("postal_human_tasks", { id: c.req.param("id"), status: "open" }, { status: "closed", closedAt: nowIso(ctx), closedBy: ctx.scope.userId });
    if (!n) throw new PostalError("NOT_FOUND", "Tâche introuvable");
    return c.json({ ok: true });
  });

  // Tableau de bord
  api.get("/dashboard", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.read");
    const rows = await ctx.db.find<Dispatch>("postal_dispatches", {});
    const byStatus: Record<string, number> = {};
    const spend: Record<string, number> = {};
    for (const d of rows) {
      byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
      if (d.approvedAt && d.quoteTtcCents) spend[d.approvedAt.slice(0, 7)] = (spend[d.approvedAt.slice(0, 7)] ?? 0) + d.quoteTtcCents;
    }
    const evidence = await ctx.db.find<Evidence>("postal_evidence", {});
    const missingEvidence = rows.filter((d) => ["DELIVERED", "POSTAL_DEPOSITED", "IN_TRANSIT"].includes(d.status) && evidenceExpected(d).some((k) => k !== "tracking" && !evidence.some((e) => e.dispatchId === d.id && e.kind === k))).length;
    return c.json({ data: { by_status: byStatus, spend_ttc_cents_by_month: spend, evidence_missing: missingEvidence, open_tasks: await ctx.db.count("postal_human_tasks", { status: "open" }) } });
  });

  api.get("/audit", async (c) => {
    const ctx = ctxOf(c);
    requirePermission(ctx, "postal.audit.read");
    return c.json({ data: await ctx.db.find("postal_audit_logs", {}, { orderBy: [["timestamp", "desc"]], limit: 500 }) });
  });

  app.route("/api/postal", api);
  app.get("/healthz", (c) => c.json({ ok: true, module_enabled: deps.config.flags.POSTAL_MODULE_ENABLED }));
  return app;
}
