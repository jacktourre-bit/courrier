import type { DispatchStatus, EvidenceKind, PostalAddress, ProviderConnection } from "../../domain/types.js";
import { isTracked } from "../../domain/types.js";
import { SP_COUNTRY_NAMES, MAX_LINE } from "../../domain/address.js";
import { httpJson } from "../http.js";
import { safeDownload } from "../../lib/safe-fetch.js";
import { sha256, toCents, truncate } from "../../lib/util.js";
import {
  ok,
  unsupported,
  type CapabilityInfo,
  type CapabilityName,
  type EvidenceResult,
  type ParsedWebhook,
  type PostalProviderAdapter,
  type PreviewResult,
  type ProviderRef,
  type ProviderResult,
  type Quote,
  type SecretStore,
  type StatusResult,
  type SubmissionRequest,
  type SubmitResult,
} from "../types.js";

/**
 * Adaptateur Service Postal — conforme à l'OpenAPI « Service Postal API » 1.7.0
 * (https://docs.servicepostal.com/, fichier sp-doc-v3.json, lu le 16/11/2026).
 * Service Postal est un prestataire d'impression/remise au réseau La Poste,
 * pas l'API officielle de La Poste.
 */
export const SP_BASE_URL = {
  sandbox: "https://sandbox-api.servicepostal.com",
  production: "https://prod-api.servicepostal.com",
} as const;

/** `GET /lettres/{uid}/infos` -> data.statut */
export const SP_INFO_STATUS: Record<string, DispatchStatus> = {
  previsualise: "PREVIEWED",
  valide: "SUBMITTED",
  annule: "CANCELLED",
  imprime: "IN_PRODUCTION",
  depose: "POSTAL_DEPOSITED",
};

/** `GET /lettres/{uid}/suivi` -> evenements[].code_statut */
export function mapSuiviCode(code: string, type: string | null): DispatchStatus | null {
  switch (code) {
    case "soumis":
      return "SUBMITTED";
    case "courrier_produit":
      return "IN_PRODUCTION";
    case "pris_en_charge":
      return type === "la_poste" ? "POSTAL_DEPOSITED" : "IN_PRODUCTION";
    case "attente_retrait_guichet":
      return "IN_TRANSIT";
    case "distribue_destinataire":
    case "distribue_destinataire_en_lot":
      return "DELIVERED";
    case "retour_expediteur":
    case "distribue_expediteur":
      return "RETURNED";
    case "ar_scanne":
      return null; // preuve disponible, pas de changement d'étape
    default:
      return null;
  }
}

interface SpLetterResponse {
  uid?: string;
  type_enveloppe?: string;
  fichier_previsualisation?: { format?: string; url?: string };
  fichier?: { url?: string };
  affranchissement?: number;
  service?: number;
  total?: number;
  type_affranchissement?: string;
  couleur?: string;
  recto_verso?: string;
}

export interface ServicePostalAdapterOptions {
  secrets: SecretStore;
  fetchImpl?: typeof fetch;
  allowProduction: boolean;
  timeoutMs?: number;
  /** Tests uniquement. */
  skipDnsCheck?: boolean;
}

function spAddress(a: PostalAddress, kind: "dest" | "exp"): ProviderResult<Record<string, string>> {
  const lines = [a.service, a.line1, a.line2, a.line3].filter((l): l is string => !!l);
  if (lines.length > 2) return { ok: false, kind: "DEFINITIVE", message: "Service Postal n'accepte que 2 lignes d'adresse" };
  if (lines.some((l) => l.length > MAX_LINE)) return { ok: false, kind: "DEFINITIVE", message: `Ligne d'adresse > ${MAX_LINE} caractères` };
  const pays = SP_COUNTRY_NAMES[a.country.toUpperCase()];
  if (!pays) return { ok: false, kind: "UNSUPPORTED", message: "Pays de destination non mappé : vérifier la liste Service Postal" };
  const out: Record<string, string> = {
    adresse_ligne1: lines[0] ?? "",
    code_postal: a.postalCode,
    ville: a.city,
    pays,
  };
  if (lines[1]) out.adresse_ligne2 = lines[1];
  if (a.company) out.nom_societe = a.company;
  if (kind === "dest") {
    if (a.civility) out.civilite = a.civility;
    if (a.firstName) out.prenom = a.firstName;
    if (a.lastName) out.nom = a.lastName;
  }
  return ok(out);
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

export class ServicePostalAdapter implements PostalProviderAdapter {
  readonly name = "servicepostal" as const;
  constructor(private readonly o: ServicePostalAdapterOptions) {}

  private async base(conn: ProviderConnection): Promise<{ url: string; headers: Record<string, string> } | ProviderResult<never>> {
    if (conn.environment === "production" && !this.o.allowProduction) {
      return { ok: false, kind: "DEFINITIVE", message: "Connexion production interdite dans cet environnement" };
    }
    const key = await this.o.secrets.get(conn.credentialsSecretRef);
    return { url: SP_BASE_URL[conn.environment], headers: { apiKey: key } };
  }

  private async call<T>(conn: ProviderConnection, method: "GET" | "POST" | "DELETE", path: string, body: unknown, creates: boolean): Promise<ProviderResult<T>> {
    const b = await this.base(conn);
    if ("ok" in b) return b;
    return httpJson<T>({
      method,
      url: `${b.url}${path}`,
      headers: b.headers,
      body,
      creates,
      timeoutMs: this.o.timeoutMs,
      fetchImpl: this.o.fetchImpl,
      classify: (status) => (status === 404 && method === "GET" ? "NOT_AVAILABLE" : null),
    });
  }

  getCapabilities(): Record<CapabilityName, CapabilityInfo> {
    const d = (note?: string): CapabilityInfo => ({ status: "documented", ...(note ? { note } : {}) });
    const c = (note: string): CapabilityInfo => ({ status: "to_confirm_contractually", note });
    return {
      preview: d("POST /lettres/previsualiser"),
      quote: d("GET /lettres/{uid}/prix (HT ; TVA 20 % sur le service)"),
      submit: d("POST /lettres/{uid}/valider après prévisualisation ; envoi immédiat POST /lettres non utilisé"),
      schedule: d("date_envoi AAAA-MM-JJ"),
      providerValidation: { status: "unsupported" },
      cancel: d("DELETE /lettres/{uid}/annuler ; fenêtre 15/30 min avant 15h30, sinon tant que rien n'est imprimé"),
      status: d("GET /lettres/{uid}/infos et /suivi (suivi pour LR, LRAR, verte suivie, performance suivie)"),
      "evidence.final_document": d("GET /lettres/{uid}/contenu (base64)"),
      "evidence.deposit_proof": d("GET /lettres/{uid}/preuve_depot (recommandés)"),
      "evidence.scanned_ar": d("GET /scannedproof/letter/{uid} (LRAR + ar_scan)"),
      webhooks: c("Activation via contact technique ; format de payload non publié dans l'OpenAPI"),
      webhookSignature: c("Aucun mécanisme de signature documenté"),
      block: { status: "unsupported" },
      attachments: d("fichier_annexes[] base64 pdf/doc/docx"),
      registered: d("lr, lrar"),
      birthday: { status: "unsupported" },
      batch: d("/publipostages/* (non branché en P1)"),
      sandbox: d("https://sandbox-api.servicepostal.com"),
    };
  }

  async validateConfig(conn: ProviderConnection) {
    const r = await this.call<{ data?: unknown[] }>(conn, "GET", "/entites/lister", undefined, false);
    if (!r.ok) return r;
    return ok({ details: { environment: conn.environment, entities: Array.isArray(r.value?.data) ? r.value.data.length : null } });
  }

  private buildLetterBody(req: SubmissionRequest): ProviderResult<Record<string, unknown>> {
    if (req.postageClass === "handwritten") return { ok: false, kind: "DEFINITIVE", message: "Affranchissement manuscrit invalide pour Service Postal" };
    if (!req.document) return { ok: false, kind: "DEFINITIVE", message: "Document principal manquant" };
    const dest = spAddress(req.recipient, "dest");
    if (!dest.ok) return dest;
    const exp = spAddress(req.sender.address, "exp");
    if (!exp.ok) return exp;
    const body: Record<string, unknown> = {
      type_affranchissement: req.postageClass,
      couleur: req.options.color ?? "nb",
      recto_verso: req.options.duplex ?? "rectoverso",
      placement_adresse: "insertion_page_adresse",
      impression_expediteur: true,
      adresse_expedition: { ...exp.value, nom_societe: truncate(req.sender.businessName, MAX_LINE) },
      adresse_destination: dest.value,
      fichier: { format: req.document.format, contenu_base64: b64(req.document.bytes) },
      reference: truncate(req.reference, 50),
    };
    if (req.annexes?.length) body.fichier_annexes = req.annexes.map((a) => ({ format: a.format, contenu_base64: b64(a.bytes) }));
    if (req.postageClass === "lrar" && req.options.arScan) {
      body.ar_scan = true;
      body.ar_expediteur_champ1 = truncate(req.reference, 38);
    }
    if (req.billingEntity) body.nom_entite = truncate(req.billingEntity.toUpperCase(), 100);
    return ok(body);
  }

  async createPreview(conn: ProviderConnection, req: SubmissionRequest): Promise<ProviderResult<PreviewResult>> {
    const body = this.buildLetterBody(req);
    if (!body.ok) return body;
    // La prévisualisation ne produit rien tant que /valider n'est pas appelé : creates=false.
    const r = await this.call<SpLetterResponse>(conn, "POST", "/lettres/previsualiser", body.value, false);
    if (!r.ok) return r;
    const v = r.value ?? {};
    if (!v.uid) return { ok: false, kind: "DEFINITIVE", message: "Réponse de prévisualisation sans UID" };
    return ok({
      ref: { uid: v.uid },
      previewUrl: v.fichier_previsualisation?.url ?? null,
      quote: quoteOf(v),
      envelope: v.type_enveloppe ?? null,
      normalizedOptions: { type_affranchissement: v.type_affranchissement, couleur: v.couleur, recto_verso: v.recto_verso },
    });
  }

  async quote(conn: ProviderConnection, ref: ProviderRef): Promise<ProviderResult<Quote>> {
    if (!ref.uid) return { ok: false, kind: "DEFINITIVE", message: "UID requis" };
    const r = await this.call<SpLetterResponse>(conn, "GET", `/lettres/${encodeURIComponent(ref.uid)}/prix`, undefined, false);
    if (!r.ok) return r;
    const q = quoteOf(r.value ?? {});
    return q ? ok(q) : { ok: false, kind: "DEFINITIVE", message: "Prix absent" };
  }

  async submit(conn: ProviderConnection, req: SubmissionRequest, ref: ProviderRef): Promise<ProviderResult<SubmitResult>> {
    // Envoi immédiat (POST /lettres) volontairement non exposé : prévisualisation + validation obligatoires.
    if (!ref.uid) return { ok: false, kind: "DEFINITIVE", message: "Prévisualisation requise avant validation" };
    const body: Record<string, string> = { reference: truncate(req.reference, 50) };
    if (req.scheduledAt) body.date_envoi = req.scheduledAt;
    const r = await this.call<SpLetterResponse>(conn, "POST", `/lettres/${encodeURIComponent(ref.uid)}/valider`, body, true);
    if (!r.ok) return r;
    return ok({ ref: { uid: r.value?.uid ?? ref.uid }, rawStatus: "valide", mappedStatus: "SUBMITTED" });
  }

  schedule(conn: ProviderConnection, ref: ProviderRef, date: string, reference: string) {
    return this.submit(conn, { reference, scheduledAt: date } as SubmissionRequest, ref);
  }

  async approve() {
    return unsupported<{ effectiveAt: string | null }>("Validation de lettre générée");
  }

  async cancel(conn: ProviderConnection, ref: ProviderRef) {
    if (!ref.uid) return { ok: false as const, kind: "DEFINITIVE" as const, message: "UID requis" };
    const r = await this.call<{ code?: number; message?: string; uid?: string }>(conn, "DELETE", `/lettres/${encodeURIComponent(ref.uid)}/annuler`, undefined, false);
    if (!r.ok) {
      if (r.kind === "DEFINITIVE") return ok({ cancelled: false, message: r.message });
      return r;
    }
    const code = r.value?.code;
    const cancelled = code === undefined || code === 200;
    return ok({ cancelled, message: (r.value?.message ?? "").slice(0, 160) });
  }

  async getStatus(conn: ProviderConnection, ref: ProviderRef): Promise<ProviderResult<StatusResult>> {
    if (!ref.uid) return { ok: false, kind: "DEFINITIVE", message: "UID requis" };
    const uid = encodeURIComponent(ref.uid);
    const info = await this.call<{ data?: { statut?: string; type_affranchissement?: string } }>(conn, "GET", `/lettres/${uid}/infos`, undefined, false);
    if (!info.ok) return info;
    const statut = info.value?.data?.statut ?? null;
    const postage = info.value?.data?.type_affranchissement;
    const events: StatusResult["events"] = [];
    let tracking: string | null = null;
    let rawTracking: unknown = null;
    const evidenceAvailable: EvidenceKind[] = [];
    let mapped: DispatchStatus | null = statut ? SP_INFO_STATUS[statut] ?? null : null;
    if (postage && isTracked(postage as never)) {
      const s = await this.call<{ numero_suivi_laposte?: string; evenements?: { date_statut?: string; code_statut?: string; type_statut?: string; message_statut?: string; pnd?: boolean }[] }>(
        conn, "GET", `/lettres/${uid}/suivi`, undefined, false,
      );
      if (s.ok) {
        rawTracking = s.value ?? null;
        tracking = s.value?.numero_suivi_laposte ?? null;
        for (const e of s.value?.evenements ?? []) {
          if (!e.code_statut) continue;
          const m = mapSuiviCode(e.code_statut, e.type_statut ?? null);
          if (e.code_statut === "ar_scanne") evidenceAvailable.push("scanned_ar");
          events.push({
            eventId: sha256(`${ref.uid}|${e.code_statut}|${e.date_statut ?? ""}`),
            eventType: e.code_statut,
            rawStatus: e.code_statut,
            mappedStatus: m,
            occurredAt: parseSpDate(e.date_statut) ?? new Date().toISOString(),
          });
        }
      }
    }
    // Le statut le plus avancé entre infos et suivi est retenu par la machine à états.
    const best = events.map((e) => e.mappedStatus).filter((x): x is DispatchStatus => !!x);
    if (best.includes("DELIVERED")) mapped = "DELIVERED";
    else if (best.includes("RETURNED")) mapped = "RETURNED";
    else if (best.includes("IN_TRANSIT")) mapped = "IN_TRANSIT";
    else if (best.includes("POSTAL_DEPOSITED") && mapped !== "CANCELLED") mapped = "POSTAL_DEPOSITED";
    const codes = new Set(events.map((e) => e.eventType));
    const deposited = statut === "depose" || best.some((x) => x === "POSTAL_DEPOSITED" || x === "IN_TRANSIT" || x === "DELIVERED" || x === "RETURNED");
    // Document final : disponible une fois le courrier produit.
    if (statut === "imprime" || statut === "depose" || codes.has("courrier_produit") || deposited) evidenceAvailable.push("final_document");
    // Preuve de dépôt : seulement après prise en charge par La Poste (pas dès « soumis »).
    if ((postage === "lr" || postage === "lrar") && deposited) evidenceAvailable.push("deposit_proof");
    return ok({ ref, rawStatus: statut, mappedStatus: mapped, events, trackingNumber: tracking, evidenceAvailable, rawTracking });
  }

  async fetchEvidence(conn: ProviderConnection, ref: ProviderRef, kind: EvidenceKind): Promise<ProviderResult<EvidenceResult>> {
    if (!ref.uid) return { ok: false, kind: "DEFINITIVE", message: "UID requis" };
    const uid = encodeURIComponent(ref.uid);
    const hosts = (conn.settingsJson.documentHostSuffixes as string[] | undefined) ?? ["servicepostal.com"];
    const dl = async (url: string | undefined, k: EvidenceKind, src: string): Promise<ProviderResult<EvidenceResult>> => {
      if (!url) return { ok: false, kind: "NOT_AVAILABLE", message: "URL absente" };
      try {
        const { bytes, contentType } = await safeDownload(url, { allowedHostSuffixes: hosts, fetchImpl: this.o.fetchImpl, skipDnsCheck: this.o.skipDnsCheck });
        return ok({ kind: k, bytes, mimeType: contentType ?? "application/octet-stream", source: src });
      } catch (e) {
        return { ok: false, kind: "DEFINITIVE", message: (e as Error).message };
      }
    };
    switch (kind) {
      case "final_document": {
        const r = await this.call<{ base64?: string }>(conn, "GET", `/lettres/${uid}/contenu`, undefined, false);
        if (!r.ok) return r;
        if (!r.value?.base64) return { ok: false, kind: "NOT_AVAILABLE", message: "Contenu pas encore généré" };
        return ok({ kind, bytes: new Uint8Array(Buffer.from(r.value.base64, "base64")), mimeType: "application/pdf", source: "servicepostal:/lettres/{uid}/contenu" });
      }
      case "deposit_proof": {
        const r = await this.call<{ url?: string }>(conn, "GET", `/lettres/${uid}/preuve_depot`, undefined, false);
        if (!r.ok) return r;
        return dl(r.value?.url, kind, "servicepostal:/lettres/{uid}/preuve_depot");
      }
      case "scanned_ar": {
        const r = await this.call<{ ScanUrl?: string }>(conn, "GET", `/scannedproof/letter/${uid}`, undefined, false);
        if (!r.ok) return r;
        return dl(r.value?.ScanUrl, kind, "servicepostal:/scannedproof/letter/{uid}");
      }
      case "preview":
        return { ok: false, kind: "UNSUPPORTED", message: "Utiliser createPreview" };
      default:
        return unsupported(kind);
    }
  }

  handleWebhook(rawBody: string): ProviderResult<ParsedWebhook> {
    // Format non publié : on n'extrait que l'UID, l'état sera relu via l'API.
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return { ok: false, kind: "DEFINITIVE", message: "JSON invalide" };
    }
    const data = (p.data as Record<string, unknown> | undefined) ?? {};
    const uid = [p.uid, p.Uid, p.lettre_uid, p.letter_uid, data.uid, data.Uid].find((x) => typeof x === "string" && /^[a-z]-[0-9a-f]{8,64}$/i.test(x)) as string | undefined;
    if (!uid) return { ok: false, kind: "DEFINITIVE", message: "UID introuvable dans le webhook" };
    const evt = [p.event, p.type, p.statut, p.code_statut, data.code_statut].find((x) => typeof x === "string") as string | undefined;
    const digest = sha256(rawBody);
    return ok({ dedupKey: digest, eventType: evt ?? "unknown", lookup: { uid }, occurredAt: null, payloadDigest: digest });
  }

  async block() {
    return unsupported<{ lettersCancelled: number | null }>("Liste de blocage");
  }
}

function quoteOf(v: SpLetterResponse): Quote | null {
  const total = toCents(v.total);
  if (total === null) return null;
  return { postageHtCents: toCents(v.affranchissement), serviceHtCents: toCents(v.service), totalHtCents: total, currency: "EUR" };
}

/**
 * Formats documentés : ISO 8601 ou « AAAA.MM.JJ.HH.MM.SS » (AR scanné). Le fuseau du second
 * format n'est pas précisé : heure de Paris supposée (UTC+1, approximation d'une heure en été) — à confirmer.
 */
export function parseSpDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})$/.exec(s);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+01:00`).toISOString();
  const t = Date.parse(s.includes("T") || s.includes("Z") ? s : s.replace(" ", "T"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
