import { PDFDocument } from "pdf-lib";

/**
 * Faux serveurs HTTP reproduisant les contrats documentés de Service Postal
 * (OpenAPI 1.7.0) et Manuscry (api-docs v1). Données fictives uniquement.
 */
export type Failure = { kind: "timeout_after_send" } | { kind: "refused" } | { kind: "status"; status: number; body?: unknown; headers?: Record<string, string> };

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export async function tinyPdf(text = "fake"): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([200, 200]).drawText(text, { x: 10, y: 100, size: 12 });
  return d.save();
}

abstract class FakeServer {
  calls: Call[] = [];
  private failures: { match: RegExp; method?: string; f: Failure; times: number }[] = [];
  fail(match: RegExp, f: Failure, opts: { method?: string; times?: number } = {}) {
    this.failures.push({ match, f, method: opts.method, times: opts.times ?? 1 });
  }
  abstract route(method: string, url: URL, body: unknown, headers: Record<string, string>): Promise<Response>;
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, url: url.href, headers, body });
    const idx = this.failures.findIndex((x) => x.match.test(url.pathname + url.search) && (!x.method || x.method === method));
    if (idx >= 0) {
      const f = this.failures[idx]!;
      if (--f.times <= 0) this.failures.splice(idx, 1);
      if (f.f.kind === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      if (f.f.kind === "timeout_after_send") {
        // Le serveur traite la requête… mais la réponse n'arrive jamais.
        await this.route(method, url, body, headers);
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return json(f.f.status, f.f.body ?? { message: `HTTP ${f.f.status}` }, f.f.headers);
    }
    return this.route(method, url, body, headers);
  };
}

// ------------------------------------------------------------- Service Postal

export interface SpLetter {
  uid: string;
  statut: "previsualise" | "valide" | "annule" | "imprime" | "depose";
  type_affranchissement: string;
  body: Record<string, unknown>;
  validations: number;
  reference?: string;
  date_envoi?: string;
  events: { date_statut: string; code_statut: string; type_statut: string; message_statut?: string }[];
  cancellable: boolean;
}

export class FakeServicePostal extends FakeServer {
  letters = new Map<string, SpLetter>();
  apiKey = "sp-test-key";
  pdf: Uint8Array | null = null;
  private n = 0;

  async route(method: string, url: URL, body: unknown, headers: Record<string, string>): Promise<Response> {
    const p = url.pathname;
    if (url.hostname.endsWith("cdn.servicepostal.com")) {
      return new Response(this.pdf ?? (await tinyPdf("preview")), { status: 200, headers: { "content-type": "application/pdf" } });
    }
    if (headers["apikey"] !== this.apiKey) return json(401, { code: 401, message: "API Key invalide" });
    if (method === "GET" && p === "/entites/lister") return json(200, { data: [] });
    if (method === "POST" && p === "/lettres/previsualiser") {
      const b = body as Record<string, unknown>;
      for (const k of ["adresse_expedition", "adresse_destination", "fichier", "type_affranchissement", "couleur"]) {
        if (!(k in b)) return json(400, { status: 400, message: `Valeur incorrecte: ${k}` });
      }
      const uid = `l-${(++this.n).toString(16).padStart(32, "0")}`;
      this.letters.set(uid, { uid, statut: "previsualise", type_affranchissement: String(b.type_affranchissement), body: b, validations: 0, events: [], cancellable: true });
      return json(200, {
        uid,
        type_enveloppe: "c6",
        fichier_previsualisation: { format: "pdf", url: `https://cdn.servicepostal.com/preview/${uid}.pdf` },
        type_affranchissement: b.type_affranchissement,
        couleur: b.couleur,
        recto_verso: b.recto_verso,
        affranchissement: b.type_affranchissement === "lrar" ? 6.4 : 1.39,
        service: 0.99,
        total: b.type_affranchissement === "lrar" ? 7.39 : 2.38,
      });
    }
    const m = /^\/lettres\/([^/]+)\/(valider|prix|infos|suivi|contenu|preuve_depot|annuler)$/.exec(p);
    const sm = /^\/scannedproof\/letter\/([^/]+)$/.exec(p);
    const uid = m?.[1] ?? sm?.[1];
    const l = uid ? this.letters.get(uid) : undefined;
    if (!l) return json(404, { code: 404, message: "Lettre introuvable" });
    if (sm) {
      const ar = l.events.find((e) => e.code_statut === "ar_scanne");
      return ar ? json(200, { Uid: l.uid, TrackingNumber: "1A000", ScanDate: "2026.11.20.10.00.00", ScanUrl: `https://cdn.servicepostal.com/ar/${l.uid}.pdf` }) : json(404, { code: 404, message: "AR indisponible" });
    }
    switch (m![2]) {
      case "valider": {
        if (l.statut !== "previsualise") return json(400, { status: 400, message: "Lettre déjà validée" });
        l.statut = "valide";
        l.validations++;
        const b = (body ?? {}) as { reference?: string; date_envoi?: string };
        l.reference = b.reference;
        l.date_envoi = b.date_envoi;
        l.events.push({ date_statut: "2026-11-16T10:00:00+01:00", code_statut: "soumis", type_statut: "service_postal" });
        return json(200, { uid: l.uid, type_affranchissement: l.type_affranchissement });
      }
      case "prix":
        return json(200, { affranchissement: 6.4, service: 0.99, total: 7.39 });
      case "infos":
        return json(200, { data: { statut: l.statut, type_affranchissement: l.type_affranchissement, date_creation: "2026-11-16" } });
      case "suivi":
        if (!["lr", "lrar", "vertesuivi", "perfsuivi"].includes(l.type_affranchissement)) return json(400, { code: 400, message: "Pas de suivi" });
        return json(200, { numero_suivi_laposte: "1A00000000001", evenements: l.events.toReversed() });
      case "contenu":
        if (l.statut !== "imprime" && l.statut !== "depose") return json(404, { code: 404, message: "Pas encore généré" });
        return json(200, { code: 200, message: "ok", base64: Buffer.from(this.pdf ?? (await tinyPdf("final"))).toString("base64") });
      case "preuve_depot":
        if (l.statut !== "depose") return json(404, { code: 404, message: "Indisponible" });
        return json(200, { format: "pdf", url: `https://cdn.servicepostal.com/proof/${l.uid}.pdf` });
      case "annuler":
        if (!l.cancellable) return json(400, { code: 400, message: "Annulation impossible : courrier imprimé" });
        l.statut = "annule";
        return json(200, { code: 200, message: "Lettre annulée", uid: l.uid });
    }
    return json(404, { code: 404, message: "?" });
  }

  /** Simule la progression physique d'un pli. */
  advance(uid: string, step: "imprime" | "depose" | "distribue" | "ar" | "retour") {
    const l = this.letters.get(uid)!;
    const at = new Date().toISOString();
    if (step === "imprime") {
      l.statut = "imprime";
      l.cancellable = false;
      l.events.push({ date_statut: at, code_statut: "courrier_produit", type_statut: "service_postal" });
    } else if (step === "depose") {
      l.statut = "depose";
      l.events.push({ date_statut: at, code_statut: "pris_en_charge", type_statut: "la_poste" });
    } else if (step === "distribue") l.events.push({ date_statut: at, code_statut: "distribue_destinataire", type_statut: "la_poste" });
    else if (step === "ar") l.events.push({ date_statut: at, code_statut: "ar_scanne", type_statut: "service_postal" });
    else l.events.push({ date_statut: at, code_statut: "retour_expediteur", type_statut: "la_poste" });
  }
}

// ------------------------------------------------------------------- Manuscry

export interface MsContact {
  campaignId: string;
  leadId: string;
  body: Record<string, string>;
}
export interface MsLetter {
  id: string;
  lead_id: string;
  lead_identifier: string;
  status: string;
  campaign: string;
  created_at: string;
}

export class FakeManuscry extends FakeServer {
  apiKey = "ms-test-key";
  contacts: MsContact[] = [];
  letters: MsLetter[] = [];
  blocked: string[] = [];
  validated: string[] = [];
  rejected: string[] = [];
  campaigns: Record<string, { type: string; status: string; can_add_contacts: boolean; fields: { key: string; required: boolean; is_custom?: boolean }[] }> = {
    "cmp-bday": {
      type: "birthday",
      status: "active",
      can_add_contacts: true,
      fields: [
        { key: "identifier", required: false },
        { key: "birthday_date", required: true },
        { key: "address_line1", required: true },
        { key: "address_line2", required: true },
        { key: "address_zip", required: true },
        { key: "address_city", required: true },
        { key: "address_country", required: true },
        { key: "prenom", required: true, is_custom: true },
      ],
    },
    "cmp-manual": {
      type: "manual",
      status: "active",
      can_add_contacts: true,
      fields: [
        { key: "address_line1", required: true },
        { key: "address_line2", required: true },
        { key: "address_zip", required: true },
        { key: "address_city", required: true },
        { key: "address_country", required: true },
        { key: "prenom", required: true, is_custom: true },
      ],
    },
  };
  private n = 0;

  async route(method: string, url: URL, body: unknown, headers: Record<string, string>): Promise<Response> {
    if (url.searchParams.has("api_key")) return json(400, { success: false, message: "clé en query refusée par le test" });
    if (headers["authorization"] !== `Bearer ${this.apiKey}`) return json(401, { success: false, error: "unauthorized", message: "Non autorisé" });
    const p = url.pathname.replace(/^\/api/, "");
    if (method === "GET" && p === "/me") return json(200, { success: true, data: { id: "u1" } });
    let m = /^\/campaigns\/([^/]+)\/settings$/.exec(p);
    if (m && method === "GET") {
      const c = this.campaigns[m[1]!];
      if (!c) return json(404, { success: false, message: "not found" });
      return json(200, { success: true, data: { campaign: { id: m[1], name: "x", type: c.type, status: c.status, can_add_contacts: c.can_add_contacts, contacts_count: 0 }, fields: c.fields, sheet_type: null } });
    }
    m = /^\/campaigns\/([^/]+)\/contacts$/.exec(p);
    if (m && method === "POST") {
      const c = this.campaigns[m[1]!];
      if (!c) return json(404, { success: false, message: "not found" });
      if (c.status !== "active") return json(403, { success: false, error: "forbidden", message: "Campaign paused" });
      const b = body as Record<string, string>;
      const missing = c.fields.filter((f) => f.required && !b[f.key]).map((f) => f.key);
      if (missing.length) return json(422, { success: false, error: "validation", message: "invalid", validation_errors: Object.fromEntries(missing.map((k) => [k, ["required"]])), missing_fields: missing, invalid_fields: [] });
      const leadId = String(++this.n);
      this.contacts.push({ campaignId: m[1]!, leadId, body: b });
      return json(201, { success: true, message: "Contact added successfully", data: { contact: { identifier: b.identifier, fields: b, created_at: "", updated_at: "" }, campaign: { id: m[1], contacts_count: this.contacts.length } } });
    }
    if (method === "GET" && p === "/letters") {
      const ident = url.searchParams.get("lead_identifier");
      return json(200, { data: this.letters.filter((l) => !ident || l.lead_identifier === ident), meta: {} });
    }
    if (method === "GET" && p === "/contacts") {
      const s = url.searchParams.get("search");
      return json(200, { data: this.contacts.filter((c) => c.body.identifier === s).map((c) => ({ id: c.leadId, identifier: c.body.identifier })) });
    }
    m = /^\/letters\/(validate|reject)\/([^/]+)$/.exec(p);
    if (m && method === "POST") {
      (m[1] === "validate" ? this.validated : this.rejected).push(m[2]!);
      return json(201, { success: true, message: "ok", data: { letter_id: m[2], scheduled_validate_at: "2026-11-16T11:00:00Z", validation_delay_minutes: 60 } });
    }
    m = /^\/contacts\/([^/]+)\/block$/.exec(p);
    if (m && method === "DELETE") {
      this.blocked.push(m[1]!);
      return json(200, { success: true, data: { lead_id: m[1], duplicates_blocked: 0, emails_cancelled: 0, letters_cancelled: 1 } });
    }
    return json(404, { success: false, message: "route inconnue" });
  }

  /** Simule la génération d'une lettre pour un contact. */
  generate(identifier: string, status = "validating"): MsLetter {
    const c = this.contacts.find((x) => x.body.identifier === identifier)!;
    const l: MsLetter = { id: `L${++this.n}`, lead_id: c.leadId, lead_identifier: identifier, status, campaign: c.campaignId, created_at: new Date().toISOString() };
    this.letters.push(l);
    return l;
  }
}
