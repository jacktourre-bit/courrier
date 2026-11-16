import { describe, expect, it } from "vitest";
import { applyProviderStatus, canTransition } from "../../src/domain/state-machine.js";
import { validateAddress, normalizeAddress } from "../../src/domain/address.js";
import { resolveMergeValues, validateTemplateFields, detectHealthTerms, renderText } from "../../src/domain/merge-fields.js";
import { approvalPolicyFor, classifySensitivity, routeProvider } from "../../src/domain/policy.js";
import { occurrenceFor } from "../../src/services/campaigns.js";
import { age, evaluateCompliance } from "../../src/services/compliance.js";
import { redact } from "../../src/lib/logger.js";
import { hostAllowed, isPrivateIp, safeDownload } from "../../src/lib/safe-fetch.js";
import { httpJson } from "../../src/providers/http.js";
import { sniffMime } from "../../src/lib/files.js";
import { toCents } from "../../src/lib/util.js";
import { scheduleInstant, ttcCents } from "../../src/services/dispatch-service.js";
import { mapSuiviCode } from "../../src/providers/servicepostal/adapter.js";
import { flagsFromEnv } from "../../src/config/flags.js";
import { renderFormalLetter } from "../../src/services/renderer.js";
import { sha256 } from "../../src/lib/util.js";

describe("machine à états", () => {
  it("ne régresse jamais sur un événement hors ordre (test 14)", () => {
    expect(applyProviderStatus("DELIVERED", "POSTAL_DEPOSITED").next).toBeNull();
    expect(applyProviderStatus("IN_TRANSIT", "SUBMITTED").next).toBeNull();
    expect(applyProviderStatus("SUBMITTED", "IN_TRANSIT").next).toBe("IN_TRANSIT");
    expect(applyProviderStatus("IN_TRANSIT", "IN_TRANSIT").reason).toBe("stale_or_equal");
  });
  it("interdit les transitions non prévues", () => {
    expect(canTransition("DRAFT", "SUBMITTED")).toBe(false);
    expect(canTransition("DELIVERED", "CANCELLED")).toBe(false);
    expect(canTransition("PENDING_APPROVAL", "APPROVED")).toBe(true);
  });
  it("mappe les codes de suivi Service Postal documentés", () => {
    expect(mapSuiviCode("pris_en_charge", "la_poste")).toBe("POSTAL_DEPOSITED");
    expect(mapSuiviCode("distribue_destinataire", "la_poste")).toBe("DELIVERED");
    expect(mapSuiviCode("retour_expediteur", "la_poste")).toBe("RETURNED");
    expect(mapSuiviCode("ar_scanne", "service_postal")).toBeNull();
  });
});

describe("adresses", () => {
  it("valide et normalise une adresse française", () => {
    const a = normalizeAddress({ lastName: "Martin", line1: " 12  rue X ", postalCode: "75 011", city: "paris", country: "fr" });
    expect(a.city).toBe("PARIS");
    expect(validateAddress(a)).toEqual([]);
  });
  it("refuse code postal invalide, ligne > 38 car. et civilité inconnue", () => {
    const issues = validateAddress({ civility: "Sir", lastName: "M", line1: "x".repeat(39), postalCode: "7501", city: "Paris", country: "FR" }).map((i) => i.code);
    expect(issues).toEqual(expect.arrayContaining(["invalid_postcode", "line_too_long", "invalid_civility"]));
  });
});

describe("variables de fusion et modèles", () => {
  const ctx = { subject: null, recipient: { lastName: "X", line1: "a", postalCode: "75001", city: "P", country: "FR" }, center: null, sender: { businessName: "S", signatory: null }, today: "2026-11-16" };
  it("valeur manquante = erreur bloquante, jamais un champ vide", () => {
    expect(() => resolveMergeValues(["patient.prenom"], ctx)).toThrow(/Valeur manquante/);
  });
  it("champ médical interdit dans un modèle relationnel", () => {
    expect(() => validateTemplateFields("relationship", ["patient.appareillage"], "x")).toThrow(/interdite/);
    expect(() => validateTemplateFields("administrative", ["patient.prenom"], "{{patient.nom}}")).toThrow(/non déclarée/);
  });
  it("champ sensible jamais résolu automatiquement", () => {
    expect(() => resolveMergeValues(["patient.nir"], ctx)).toThrow(/non résolue/);
  });
  it("détecte les termes santé (filet de sécurité ai_context)", () => {
    expect(detectHealthTerms("Suite à votre appareillage auditif")).toContain("appareillage");
    expect(detectHealthTerms("Belle journée !")).toEqual([]);
  });
  it("rend les placeholders", () => {
    expect(renderText("Bonjour {{ patient.prenom }}", { "patient.prenom": "Alice" })).toBe("Bonjour Alice");
  });
});

describe("sensibilité, routage, approbations", () => {
  const base = { declared: "personal_non_health" as const, mergeFieldKeys: [], attachments: [], subjectType: "patient" as const, concernsPatient: true, recipientOrgCategory: null, freeTexts: [], purpose: "administrative" as const };
  it("patient + CPAM = santé", () => {
    expect(classifySensitivity({ ...base, recipientOrgCategory: "cpam" }).level).toBe("health");
  });
  it("audiogramme joint = santé", () => {
    expect(classifySensitivity({ ...base, attachments: [{ category: "audiogram", declared: "personal_non_health" }] }).level).toBe("health");
  });
  it("routage : manuscrit -> Manuscry ; LRAR -> Service Postal ; pas d'annexe chez Manuscry", () => {
    expect(routeProvider({ purpose: "relationship", rendering: "handwritten", postageClass: "handwritten", hasAttachments: false, needsProof: false })).toBe("manuscry");
    expect(routeProvider({ purpose: "legal", rendering: "formal", postageClass: "lrar", hasAttachments: true, needsProof: true })).toBe("servicepostal");
    expect(() => routeProvider({ purpose: "relationship", rendering: "handwritten", postageClass: "handwritten", hasAttachments: true, needsProof: false })).toThrow();
  });
  it("LRAR = double validation quatre-yeux ; santé = étape supplémentaire", () => {
    const p = approvalPolicyFor({ purpose: "administrative", postageClass: "lrar", sensitivity: "personal_non_health", sourceType: "admin_file" }, false);
    expect(p.steps.map((s) => s.step)).toEqual(["review", "final_legal"]);
    const h = approvalPolicyFor({ purpose: "administrative", postageClass: "ecopli", sensitivity: "health", sourceType: "patient_file" }, false);
    expect(h.steps.map((s) => s.step)).toContain("sensitive");
  });
});

describe("anniversaires et âge", () => {
  it("29 février en année non bissextile (test 4)", () => {
    expect(occurrenceFor("2000-02-29", 2027, "feb28")).toBe("2027-02-28");
    expect(occurrenceFor("2000-02-29", 2027, "mar1")).toBe("2027-03-01");
    expect(occurrenceFor("2000-02-29", 2028, "feb28")).toBe("2028-02-29");
  });
  it("âge exact", () => {
    expect(age("2008-11-17", "2026-11-16")).toBe(17);
    expect(age("2008-11-16", "2026-11-16")).toBe(18);
  });
});

describe("compliance", () => {
  it("bloque la donnée de santé quand le flag est désactivé (test 22)", () => {
    const r = evaluateCompliance({
      purpose: "administrative", provider: "servicepostal", legalEntityId: "le", subject: null, subjectIsPatient: true, recipientAddress: null, organization: null,
      sender: null, template: null, templateVersion: null, preferences: [], requireExplicitOptIn: false, duplicateDispatchId: null, sensitivity: "health",
      sensitiveFlag: false, sensitiveAuthorization: null, automated: false, allowMinors: false, addressMaxAgeDays: null, today: "2026-11-16",
    });
    expect(r.blockers.map((b) => b.code)).toContain("sensitive_flag_off");
  });
});

describe("sécurité technique", () => {
  it("caviarde secrets, adresses, documents et URLs dans les logs (test 23)", () => {
    const r = JSON.stringify(redact({ apiKey: "k", headers: { Authorization: "Bearer x" }, fichier: { contenu_base64: "JVBER" }, adresse_destination: { nom: "Martin" }, link: "https://x/y.pdf", ok: 1 }));
    expect(r).not.toMatch(/Bearer|JVBER|Martin|https:/);
    expect(r).toContain('"ok":1');
  });
  it("SSRF : IP privées, hôtes hors liste et HTTP refusés", async () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(hostAllowed("cdn.servicepostal.com", ["servicepostal.com"])).toBe(true);
    expect(hostAllowed("servicepostal.com.evil.io", ["servicepostal.com"])).toBe(false);
    await expect(safeDownload("http://cdn.servicepostal.com/a.pdf", { allowedHostSuffixes: ["servicepostal.com"] })).rejects.toThrow(/HTTPS/);
    await expect(safeDownload("https://127.0.0.1/a", { allowedHostSuffixes: ["servicepostal.com"] })).rejects.toThrow(/IP/);
    await expect(safeDownload("https://evil.io/a", { allowedHostSuffixes: ["servicepostal.com"] })).rejects.toThrow(/non autorisé/);
  });
  it("timeout après émission d'une création => UNKNOWN (jamais RETRYABLE)", async () => {
    const f = (async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    const r = await httpJson({ method: "POST", url: "https://x", headers: {}, body: {}, creates: true, fetchImpl: f });
    expect(!r.ok && r.kind).toBe("UNKNOWN");
    const refused = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const r2 = await httpJson({ method: "POST", url: "https://x", headers: {}, body: {}, creates: true, fetchImpl: refused });
    expect(!r2.ok && r2.kind).toBe("RETRYABLE");
  });
  it("429 respecte Retry-After ; 5xx sur création => UNKNOWN", async () => {
    const f429 = (async () => new Response("{}", { status: 429, headers: { "retry-after": "12" } })) as unknown as typeof fetch;
    const r = await httpJson({ method: "POST", url: "https://x", headers: {}, creates: true, fetchImpl: f429 });
    expect(!r.ok && r.retryAfterMs).toBe(12_000);
    const f500 = (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch;
    const r5 = await httpJson({ method: "POST", url: "https://x", headers: {}, creates: true, fetchImpl: f500 });
    expect(!r5.ok && r5.kind).toBe("UNKNOWN");
  });
  it("signature binaire de fichier vérifiée", () => {
    expect(sniffMime(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMime(new TextEncoder().encode("<html>"))).toBeNull();
  });
  it("hors production, aucune connexion production possible", () => {
    expect(flagsFromEnv({ NODE_ENV: "development", POSTAL_PRODUCTION_PROVIDERS_ALLOWED: "true" }).POSTAL_PRODUCTION_PROVIDERS_ALLOWED).toBe(false);
    expect(flagsFromEnv({}).SENSITIVE_POSTAL_ALLOWED).toBe(false);
  });
});

describe("montants et fuseau", () => {
  it("centimes exacts et TTC (TVA sur le service uniquement)", () => {
    expect(toCents(7.39)).toBe(739);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(ttcCents({ config: { serviceVatRate: 0.2 } } as never, 640, 99, 739)).toBe(640 + 119);
  });
  it("programmation à 08:00 Europe/Paris en hiver et en été (test 28)", () => {
    expect(scheduleInstant("2026-12-15")).toBe("2026-12-15T07:00:00.000Z");
    expect(scheduleInstant("2027-07-15")).toBe("2027-07-15T06:00:00.000Z");
  });
});

describe("rendu PDF", () => {
  it("déterministe : même contenu => même SHA-256", async () => {
    const input = {
      sender: { businessName: "S", address: { line1: "1 rue", postalCode: "69002", city: "LYON", country: "FR" } },
      recipient: { lastName: "Martin", line1: "2 rue", postalCode: "75011", city: "PARIS", country: "FR" },
      content: { subject: "Objet", body: "Corps accentué é è à ç € ’ — test" },
      values: {},
      placeAndDate: "Lyon, le 16 novembre 2026",
      reference: "CORR-x",
    };
    const a = await renderFormalLetter(input);
    const b = await renderFormalLetter(input);
    expect(sha256(a.bytes)).toBe(sha256(b.bytes));
    expect(a.pageCount).toBe(1);
  });
});
