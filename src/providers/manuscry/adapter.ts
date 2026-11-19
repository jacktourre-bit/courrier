/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Le traducteur vers Manuscry (cartes écrites à la main). Particularités de leur API : l'ajout
 * d'un contact ne renvoie pas d'identifiant de lettre, donc on retrouve tout grâce à notre
 * référence CORR-… ; une date d'envoi passée part immédiatement, donc on la refuse ; pas
 * d'environnement de test, donc écritures interdites hors production.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { DispatchStatus, ProviderConnection } from "../../domain/types.js";
import { httpJson } from "../http.js";
import { sha256, parisDate } from "../../lib/util.js";
import {
  ok,
  unsupported,
  type CapabilityInfo,
  type CapabilityName,
  type FailureKind,
  type ParsedWebhook,
  type PostalProviderAdapter,
  type PreviewResult,
  type ProviderRef,
  type ProviderResult,
  type SecretStore,
  type StatusResult,
  type SubmissionRequest,
  type SubmitResult,
} from "../types.js";

/**
 * Adaptateur Manuscry — d'après https://manuscry.com/api-docs et
 * https://manuscry.com/openapi/api-manuscry-v1.yaml (lus le 16/11/2026).
 *
 * Faits structurants :
 *  - l'ajout de contact ne renvoie NI id de lettre NI id de lead : seul
 *    `identifier` (fixé par nous, opaque) permet le rapprochement ;
 *  - `scheduled_at` passé => envoi immédiat : on ne transmet jamais une date passée ;
 *  - aucune sandbox, aucune signature de webhook, aucun id d'événement documentés ;
 *  - 403 = campagne en pause/annulée ; 100 req/min ; aperçu partenaire 10/min.
 */
export const MANUSCRY_BASE_URL = "https://manuscry.com/api";

export const MANUSCRY_LETTER_STATUS: Record<string, DispatchStatus> = {
  validating: "SUBMITTED",
  generating: "IN_PRODUCTION",
  printing: "IN_PRODUCTION",
  sending: "POSTAL_DEPOSITED", // sémantique exacte à confirmer avec le fournisseur
  transiting: "IN_TRANSIT",
  delivered: "DELIVERED",
  returned: "RETURNED",
  cancelled: "CANCELLED",
  error: "FAILED_PROVIDER",
};

export const MANUSCRY_WEBHOOK_STATUS: Record<string, DispatchStatus | null> = {
  letter_ready_for_validation: null,
  letter_sent: "POSTAL_DEPOSITED",
  letter_delivered: "DELIVERED",
  letter_returned: "RETURNED",
  qr_code_scanned: null,
  new_calendar_event: null,
};

export interface ManuscryCampaignSettings {
  campaign: { id: string; name?: string; type: string; status: string; can_add_contacts: boolean };
  fields: { key: string; label?: string; type?: string; required?: boolean; is_custom?: boolean; is_in_letter?: boolean; validation_type?: string }[];
  sheet_type?: string | null;
}

interface ManuscryLetter {
  id: string | number;
  lead_id?: string | number;
  lead_identifier?: string;
  status?: string;
  tracking_code?: string | null;
  is_returned?: boolean;
  sent_at?: string | null;
  delivered_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ManuscryAdapterOptions {
  secrets: SecretStore;
  fetchImpl?: typeof fetch;
  /** Manuscry n'a pas de sandbox documentée : en non-production, tout appel d'écriture est refusé. */
  allowWrites: boolean;
  timeoutMs?: number;
  clock?: () => Date;
}

/** Champs système de la campagne (adresse, identifiant…) — les autres sont des variables de lettre. */
const SYSTEM_FIELDS = new Set(["identifier", "address_line1", "address_line2", "address_line3", "address_zip", "address_city", "address_country", "birthday_date", "scheduled_at", "ai_context", "linkedin_url"]);

export class ManuscryAdapter implements PostalProviderAdapter {
  readonly name = "manuscry" as const;
  constructor(private readonly o: ManuscryAdapterOptions) {}

  private now = () => (this.o.clock ? this.o.clock() : new Date());

  private async call<T>(conn: ProviderConnection, method: "GET" | "POST" | "DELETE", path: string, body: unknown, creates: boolean): Promise<ProviderResult<T>> {
    if (method !== "GET" && !this.o.allowWrites) {
      return { ok: false, kind: "DEFINITIVE", message: "Écritures Manuscry interdites dans cet environnement (pas de sandbox documentée)" };
    }
    const key = await this.o.secrets.get(conn.credentialsSecretRef);
    return httpJson<T>({
      method,
      url: `${MANUSCRY_BASE_URL}${path}`,
      // Clé uniquement en en-tête : la variante ?api_key= est proscrite (§7).
      headers: { Authorization: `Bearer ${key}` },
      body,
      creates,
      timeoutMs: this.o.timeoutMs,
      fetchImpl: this.o.fetchImpl,
      classify: (status): FailureKind | null => (status === 403 ? "CAMPAIGN_INACTIVE" : status === 404 && method === "GET" ? "NOT_AVAILABLE" : null),
    });
  }

  getCapabilities(): Record<CapabilityName, CapabilityInfo> {
    const d = (note?: string): CapabilityInfo => ({ status: "documented", ...(note ? { note } : {}) });
    const c = (note: string): CapabilityInfo => ({ status: "to_confirm_contractually", note });
    const u = (note?: string): CapabilityInfo => ({ status: "unsupported", ...(note ? { note } : {}) });
    return {
      preview: c("POST /partners/campaigns/{id}/preview : PNG filigrané, activation manuelle par Manuscry"),
      quote: u("Aucun endpoint de prix documenté"),
      submit: d("POST /campaigns/{id}/contacts (un objet par requête)"),
      schedule: d("scheduled_at YYYY-MM-DD (campagne manuelle) ; une date passée part immédiatement"),
      providerValidation: d("POST /letters/validate|reject/{letterId} ; délai de 60 min"),
      cancel: c("Pas d'endpoint d'annulation : refus pendant la validation, ou blocage du contact"),
      status: d("GET /letters?lead_identifier="),
      "evidence.final_document": u(),
      "evidence.deposit_proof": u(),
      "evidence.scanned_ar": u(),
      webhooks: d("Configurés dans l'interface Manuscry ; pas d'id d'événement"),
      webhookSignature: c("Aucune signature documentée"),
      block: d("DELETE /contacts/{leadId}/block ; /blocklist"),
      attachments: u(),
      registered: u(),
      birthday: c("birthday_date ; envoi 5 j avant (FR) / 10 j (international) ; récurrence annuelle non documentée"),
      batch: d("via campagnes"),
      sandbox: u("Aucun environnement de test documenté"),
    };
  }

  // EN CLAIR : Lit la configuration d'une campagne Manuscry : type, statut, champs obligatoires.
  async getCampaignSettings(conn: ProviderConnection, campaignId: string): Promise<ProviderResult<ManuscryCampaignSettings>> {
    const r = await this.call<{ success?: boolean; data?: ManuscryCampaignSettings } & Partial<ManuscryCampaignSettings>>(
      conn, "GET", `/campaigns/${encodeURIComponent(campaignId)}/settings`, undefined, false,
    );
    if (!r.ok) return r;
    const s = r.value?.data ?? (r.value as ManuscryCampaignSettings);
    if (!s?.campaign) return { ok: false, kind: "DEFINITIVE", message: "Réponse settings inattendue" };
    return ok(s);
  }

  // EN CLAIR : Liste les variables de la lettre (ex. « prenom »), lues chez Manuscry, jamais écrites en
  // dur dans le code.
  /** Clés de variables de lettre, lues dynamiquement (jamais codées en dur). */
  static letterVariableKeys(s: ManuscryCampaignSettings): string[] {
    return s.fields.filter((f) => !SYSTEM_FIELDS.has(f.key)).map((f) => f.key);
  }

  async validateConfig(conn: ProviderConnection) {
    const me = await this.call<Record<string, unknown>>(conn, "GET", "/me", undefined, false);
    if (!me.ok) return me;
    const campaigns = (conn.settingsJson.campaigns as Record<string, string> | undefined) ?? {};
    const details: Record<string, unknown> = {};
    for (const [purpose, id] of Object.entries(campaigns)) {
      const s = await this.getCampaignSettings(conn, id);
      details[purpose] = s.ok ? { type: s.value.campaign.type, status: s.value.campaign.status, can_add_contacts: s.value.campaign.can_add_contacts } : { error: s.kind };
    }
    return ok({ details });
  }

  async createPreview(conn: ProviderConnection, req: SubmissionRequest): Promise<ProviderResult<PreviewResult>> {
    if (!conn.settingsJson.partnerPreviewEnabled) return unsupported("Aperçu partenaire (non activé pour ce compte)");
    if (!req.campaignId) return { ok: false, kind: "DEFINITIVE", message: "campaignId requis" };
    const key = await this.o.secrets.get(conn.credentialsSecretRef);
    try {
      const res = await (this.o.fetchImpl ?? fetch)(`${MANUSCRY_BASE_URL}/partners/campaigns/${encodeURIComponent(req.campaignId)}/preview`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "image/png" },
        // Données fictives ou minimales uniquement : l'aperçu ne crée ni crédit ni contact.
        body: JSON.stringify({ fields: req.variables ?? {}, surface: "front", width: 600 }),
        redirect: "error",
      });
      if (res.status === 429) return { ok: false, kind: "RATE_LIMITED", message: "aperçu : 10/min", retryAfterMs: 60_000 };
      if (!res.ok) return { ok: false, kind: res.status === 403 ? "UNSUPPORTED" : "DEFINITIVE", message: `aperçu HTTP ${res.status}`, httpStatus: res.status };
      const img = new Uint8Array(await res.arrayBuffer());
      return ok({ ref: { campaignId: req.campaignId }, previewUrl: null, previewImage: img, quote: null, normalizedOptions: {} });
    } catch {
      return { ok: false, kind: "RETRYABLE", message: "aperçu : erreur réseau" };
    }
  }

  async quote() {
    return unsupported<never>("Devis");
  }

  // EN CLAIR : Prépare la fiche envoyée à Manuscry : nom en ligne 1, rue en ligne 2, ville en
  // majuscules, date d'anniversaire si besoin.
  buildContactBody(req: SubmissionRequest, campaignType: string): ProviderResult<Record<string, string>> {
    const a = req.recipient;
    const name = [a.civility, a.firstName, a.lastName].filter(Boolean).join(" ") || a.company || "";
    if (!name || !a.line1 || !a.postalCode || !a.city || !a.country) return { ok: false, kind: "DEFINITIVE", message: "Adresse incomplète" };
    const body: Record<string, string> = {
      identifier: req.reference,
      address_line1: name,
      address_line2: a.line1,
      address_zip: a.postalCode,
      address_city: a.city.toUpperCase(),
      address_country: a.country.toUpperCase(),
    };
    const extra = [a.line2, a.line3].filter(Boolean).join(" ");
    if (extra) body.address_line3 = extra;
    if (campaignType === "birthday") {
      if (!req.birthdayDate || !/^\d{4}-\d{2}-\d{2}$/.test(req.birthdayDate)) return { ok: false, kind: "DEFINITIVE", message: "birthday_date requis" };
      body.birthday_date = req.birthdayDate;
    } else if (req.scheduledAt) {
      // Une date passée déclencherait un envoi immédiat : refus.
      if (req.scheduledAt <= parisDate(this.now())) return { ok: false, kind: "DEFINITIVE", message: "scheduled_at doit être strictement futur" };
      body.scheduled_at = req.scheduledAt;
    }
    if (req.aiContext) body.ai_context = req.aiContext;
    for (const [k, v] of Object.entries(req.variables ?? {})) {
      if (SYSTEM_FIELDS.has(k)) return { ok: false, kind: "DEFINITIVE", message: `Variable réservée : ${k}` };
      body[k] = v;
    }
    return ok(body);
  }

  // EN CLAIR : Ajoute le contact à la campagne après avoir vérifié qu'elle est active et que les champs
  // obligatoires sont remplis.
  async submit(conn: ProviderConnection, req: SubmissionRequest): Promise<ProviderResult<SubmitResult>> {
    if (!req.campaignId) return { ok: false, kind: "DEFINITIVE", message: "campaignId requis" };
    const settings = await this.getCampaignSettings(conn, req.campaignId);
    if (!settings.ok) return settings;
    const c = settings.value.campaign;
    if (c.status !== "active") return { ok: false, kind: "CAMPAIGN_INACTIVE", message: `Campagne ${c.status}` };
    if (!c.can_add_contacts) return { ok: false, kind: "DEFINITIVE", message: "Campagne n'acceptant pas d'ajout de contacts" };
    const required = settings.value.fields.filter((f) => f.required && !SYSTEM_FIELDS.has(f.key)).map((f) => f.key);
    const missing = required.filter((k) => !req.variables?.[k]);
    if (missing.length) return { ok: false, kind: "DEFINITIVE", message: "Variables de campagne manquantes", fields: missing };
    const body = this.buildContactBody(req, c.type);
    if (!body.ok) return body;
    const r = await this.call<{ success?: boolean; warnings?: unknown[]; data?: { contact?: { identifier?: string } } }>(
      conn, "POST", `/campaigns/${encodeURIComponent(req.campaignId)}/contacts`, body.value, true,
    );
    if (!r.ok) return r;
    const warned = Array.isArray(r.value?.warnings) && r.value.warnings.length > 0;
    return ok({
      ref: { identifier: r.value?.data?.contact?.identifier ?? req.reference, campaignId: req.campaignId },
      rawStatus: warned ? "contact_added_with_warnings" : "contact_added",
      mappedStatus: "SUBMITTED",
    });
  }

  async schedule() {
    return unsupported<SubmitResult>("Programmation séparée (utiliser scheduled_at à la soumission)");
  }

  // EN CLAIR : Valide ou refuse la lettre générée par Manuscry (fenêtre de 60 minutes).
  async approve(conn: ProviderConnection, ref: ProviderRef, decision: "validate" | "reject") {
    if (!ref.letterId) return { ok: false as const, kind: "DEFINITIVE" as const, message: "letterId requis" };
    const path = decision === "validate" ? `/letters/validate/${encodeURIComponent(ref.letterId)}` : `/letters/reject/${encodeURIComponent(ref.letterId)}`;
    const r = await this.call<{ data?: { scheduled_validate_at?: string; scheduled_delete_at?: string } }>(conn, "POST", path, decision === "validate" ? {} : undefined, false);
    if (!r.ok) return r;
    return ok({ effectiveAt: r.value?.data?.scheduled_validate_at ?? r.value?.data?.scheduled_delete_at ?? null });
  }

  // EN CLAIR : Cherche les lettres liées à notre référence CORR-….
  async findLetters(conn: ProviderConnection, identifier: string, campaignId?: string | null): Promise<ProviderResult<ManuscryLetter[]>> {
    const q = new URLSearchParams({ lead_identifier: identifier, per_page: "20" });
    if (campaignId) q.set("campaign_filter", campaignId);
    const r = await this.call<{ data?: ManuscryLetter[] }>(conn, "GET", `/letters?${q}`, undefined, false);
    if (!r.ok) return r;
    // Filtre défensif : on ne garde que l'identifiant exact.
    return ok((r.value?.data ?? []).filter((l) => l.lead_identifier === identifier));
  }

  // EN CLAIR : Vérifie si le contact existe chez Manuscry (utile après une coupure réseau).
  /** Recherche du contact (rapprochement après timeout). Correspondance par `identifier` à confirmer avec Manuscry. */
  async findContact(conn: ProviderConnection, identifier: string, campaignId?: string | null): Promise<ProviderResult<{ found: boolean; leadId: string | null }>> {
    const q = new URLSearchParams({ search: identifier });
    if (campaignId) q.set("campaign_filter", campaignId);
    const r = await this.call<{ data?: { id?: string | number; identifier?: string; lead_identifier?: string }[] }>(conn, "GET", `/contacts?${q}`, undefined, false);
    if (!r.ok) return r;
    const hit = (r.value?.data ?? []).find((c) => c.identifier === identifier || c.lead_identifier === identifier);
    return ok({ found: !!hit, leadId: hit?.id !== undefined ? String(hit.id) : null });
  }

  // EN CLAIR : Donne l'état réel de la carte chez Manuscry.
  async getStatus(conn: ProviderConnection, ref: ProviderRef): Promise<ProviderResult<StatusResult>> {
    if (!ref.identifier) return { ok: false, kind: "DEFINITIVE", message: "identifier requis" };
    const letters = await this.findLetters(conn, ref.identifier, ref.campaignId);
    if (!letters.ok) return letters;
    if (letters.value.length === 0) {
      const contact = await this.findContact(conn, ref.identifier, ref.campaignId);
      if (!contact.ok) return contact;
      return ok({
        ref: { ...ref, leadId: contact.value.leadId },
        rawStatus: contact.value.found ? "contact_without_letter" : "not_found",
        mappedStatus: contact.value.found ? "SUBMITTED" : null,
        events: [],
      });
    }
    const latest = letters.value.toSorted((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0]!;
    const raw = latest.is_returned ? "returned" : latest.status ?? null;
    return ok({
      ref: { ...ref, letterId: String(latest.id), leadId: latest.lead_id !== undefined ? String(latest.lead_id) : ref.leadId ?? null },
      rawStatus: raw,
      mappedStatus: raw ? MANUSCRY_LETTER_STATUS[raw] ?? null : null,
      events: [],
      trackingNumber: latest.tracking_code ?? null,
      awaitingProviderValidation: raw === "validating",
    });
  }

  // EN CLAIR : Annulation : possible seulement pendant la validation ; sinon il faut bloquer le contact.
  async cancel(conn: ProviderConnection, ref: ProviderRef) {
    const st = await this.getStatus(conn, ref);
    if (!st.ok) return st;
    if (st.value.awaitingProviderValidation && st.value.ref.letterId) {
      const r = await this.approve(conn, st.value.ref, "reject");
      if (!r.ok) return r;
      return ok({ cancelled: true, message: "Lettre refusée pendant la fenêtre de validation" });
    }
    return ok({ cancelled: false, message: "Annulation non disponible à ce stade : utiliser le blocage du contact (opposition)" });
  }

  async fetchEvidence() {
    return unsupported<never>("Preuves");
  }

  // EN CLAIR : Lit une notification Manuscry. Les scans de QR code sont ignorés pour les patients.
  handleWebhook(rawBody: string): ProviderResult<ParsedWebhook> {
    let p: { event?: string; timestamp?: string; campaign_id?: string | number; data?: Record<string, Record<string, unknown>> };
    try {
      p = JSON.parse(rawBody);
    } catch {
      return { ok: false, kind: "DEFINITIVE", message: "JSON invalide" };
    }
    const event = typeof p.event === "string" ? p.event : null;
    if (!event || !(event in MANUSCRY_WEBHOOK_STATUS)) return { ok: false, kind: "DEFINITIVE", message: "Événement inconnu" };
    const d = p.data ?? {};
    const obj = d.letter ?? d.scan ?? d.lead ?? {};
    const identifier = typeof obj.lead_identifier === "string" ? obj.lead_identifier : null;
    const letterId = d.letter?.id ?? d.scan?.letter_id;
    const leadId = d.letter?.lead_id ?? d.scan?.lead_id ?? d.lead?.id;
    const digest = sha256(rawBody);
    const base = {
      eventType: event,
      lookup: {
        identifier,
        letterId: letterId !== undefined ? String(letterId) : null,
        leadId: leadId !== undefined ? String(leadId) : null,
        campaignId: p.campaign_id !== undefined ? String(p.campaign_id) : null,
      },
      occurredAt: typeof p.timestamp === "string" ? p.timestamp : null,
      payloadDigest: digest,
      // Pas d'id d'événement fourni : clé de déduplication dérivée.
      dedupKey: sha256(`${event}|${p.timestamp ?? ""}|${letterId ?? ""}|${identifier ?? ""}`),
    };
    if (event === "qr_code_scanned") return ok({ ...base, ignore: "Suivi QR désactivé pour les patients (§7, §13.1)" });
    if (event === "new_calendar_event") return ok({ ...base, ignore: "Hors périmètre" });
    if (!identifier && !base.lookup.letterId) return { ok: false, kind: "DEFINITIVE", message: "Aucun identifiant exploitable" };
    return ok(base);
  }

  // EN CLAIR : Bloque le contact chez Manuscry (suite à une opposition du patient).
  async block(conn: ProviderConnection, ref: ProviderRef) {
    let leadId = ref.leadId;
    if (!leadId && ref.identifier) {
      const st = await this.getStatus(conn, ref);
      if (st.ok) leadId = st.value.ref.leadId ?? null;
    }
    if (!leadId) return { ok: false as const, kind: "NOT_AVAILABLE" as const, message: "leadId inconnu : blocage impossible pour l'instant" };
    const r = await this.call<{ data?: { letters_cancelled?: number } }>(conn, "DELETE", `/contacts/${encodeURIComponent(leadId)}/block`, undefined, false);
    if (!r.ok) return r;
    return ok({ lettersCancelled: r.value?.data?.letters_cancelled ?? null });
  }
}
