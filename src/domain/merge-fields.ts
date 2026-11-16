import type { Purpose, Sensitivity, Subject, PostalAddress } from "./types.js";
import { PostalError } from "../lib/errors.js";

/**
 * Registre fermé des variables de fusion. Un modèle ne peut utiliser qu'un
 * sous-ensemble déclaré de ce registre ; tout champ de catégorie `health` ou
 * `sensitive` est interdit dans un modèle relationnel/marketing (§4.4).
 */
export type FieldCategory = "identity" | "address" | "center" | "sender" | "file" | "date" | "sensitive" | "health";

export interface FieldDef {
  key: string;
  category: FieldCategory;
  label: string;
}

export const FIELD_REGISTRY: FieldDef[] = [
  { key: "patient.civilite", category: "identity", label: "Civilité" },
  { key: "patient.prenom", category: "identity", label: "Prénom" },
  { key: "patient.nom", category: "identity", label: "Nom" },
  { key: "destinataire.nom_complet", category: "identity", label: "Nom complet destinataire" },
  { key: "destinataire.societe", category: "identity", label: "Organisme / société" },
  { key: "destinataire.service", category: "identity", label: "Service destinataire" },
  { key: "centre.nom", category: "center", label: "Nom du centre" },
  { key: "centre.telephone", category: "center", label: "Téléphone du centre" },
  { key: "centre.adresse", category: "center", label: "Adresse du centre" },
  { key: "societe.nom", category: "sender", label: "Société émettrice" },
  { key: "signataire.nom", category: "sender", label: "Signataire" },
  { key: "dossier.reference_publique", category: "file", label: "Référence publique du dossier" },
  { key: "date.jour", category: "date", label: "Date du jour" },
  // Champs sensibles : jamais disponibles hors autorisation SENSITIVE_POSTAL_ALLOWED.
  { key: "patient.date_naissance", category: "sensitive", label: "Date de naissance" },
  { key: "patient.nir", category: "sensitive", label: "N° de sécurité sociale" },
  { key: "patient.organisme_couverture", category: "sensitive", label: "Couverture sociale" },
  { key: "patient.appareillage", category: "health", label: "Appareillage" },
  { key: "patient.diagnostic", category: "health", label: "Diagnostic" },
  { key: "patient.prescription", category: "health", label: "Prescription" },
  { key: "patient.handicap", category: "health", label: "Handicap / MDPH" },
];

const BY_KEY = new Map(FIELD_REGISTRY.map((f) => [f.key, f]));

export const fieldCategory = (key: string): FieldCategory | null => BY_KEY.get(key)?.category ?? null;

export const RELATIONAL_PURPOSES: Purpose[] = ["relationship", "marketing"];

export function fieldsSensitivity(keys: string[]): Sensitivity {
  let s: Sensitivity = keys.length ? "personal_non_health" : "public";
  for (const k of keys) {
    const c = fieldCategory(k);
    if (c === "health") return "health";
    if (c === "sensitive") s = "personal_sensitive";
  }
  return s;
}

/** Contrôle à l'enregistrement d'une version de modèle. */
export function validateTemplateFields(purpose: Purpose, allowed: string[], body: string): void {
  for (const k of allowed) {
    const c = fieldCategory(k);
    if (!c) throw new PostalError("VALIDATION", `Variable inconnue : ${k}`);
    if (RELATIONAL_PURPOSES.includes(purpose) && (c === "health" || c === "sensitive")) {
      throw new PostalError("COMPLIANCE_BLOCKED", `Variable ${k} interdite dans un modèle ${purpose}`);
    }
  }
  for (const used of extractPlaceholders(body)) {
    if (!allowed.includes(used)) throw new PostalError("VALIDATION", `Variable ${used} utilisée mais non déclarée`);
  }
}

export function extractPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g)) out.add(m[1]!);
  return [...out];
}

export interface MergeContext {
  subject: Subject | null;
  recipient: PostalAddress;
  center: { name: string; phone: string | null; address: string | null } | null;
  sender: { businessName: string; signatory: string | null };
  today: string;
}

/** NIR (n° de sécurité sociale) : 13 chiffres + clé = 97 - (nombre mod 97) ; Corse 2A -> 19, 2B -> 18. */
export function isValidNir(raw: string): boolean {
  const v = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[1-478]\d{4}(\d{2}|2A|2B)\d{6}\d{2}$/.test(v)) return false;
  const body = v.slice(0, 13).replace("2A", "19").replace("2B", "18");
  const key = Number(v.slice(13));
  return 97 - Number(BigInt(body) % 97n) === key;
}

/**
 * Valeurs sensibles/santé : jamais déduites du dossier, toujours saisies par un
 * utilisateur habilité pour CE courrier (minimisation, §13.1).
 */
export function validateSensitiveValues(allowed: string[], provided: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(provided)) {
    const c = fieldCategory(k);
    if (c !== "health" && c !== "sensitive") throw new PostalError("VALIDATION", `${k} n'est pas un champ sensible`);
    if (!allowed.includes(k)) throw new PostalError("VALIDATION", `${k} non autorisé par le modèle`);
    const val = v.replace(/\s+/g, " ").trim();
    if (!val || val.length > 300 || /[\r\n]/.test(v)) throw new PostalError("VALIDATION", `Valeur invalide pour ${k}`);
    if (k === "patient.nir" && !isValidNir(val)) throw new PostalError("VALIDATION", "NIR invalide (clé de contrôle)");
    if (k === "patient.date_naissance" && !/^\d{2}\/\d{2}\/\d{4}$/.test(val)) throw new PostalError("VALIDATION", "Date de naissance attendue JJ/MM/AAAA");
    out[k] = k === "patient.nir" ? val.replace(/\s+/g, "").toUpperCase() : val;
  }
  for (const k of allowed) {
    const c = fieldCategory(k);
    if ((c === "health" || c === "sensitive") && !(k in out)) throw new PostalError("VALIDATION", `Saisie requise par un utilisateur habilité : ${k}`, { field: k });
  }
  return out;
}

/** Valeurs calculées depuis les sources de vérité. Les champs sensibles/santé ne sont jamais résolus ici. */
export function resolveMergeValues(allowed: string[], ctx: MergeContext, opts: { skipSensitive?: boolean } = {}): Record<string, string> {
  const values: Record<string, string | null | undefined> = {
    "patient.civilite": ctx.subject?.civility,
    "patient.prenom": ctx.subject?.firstName,
    "patient.nom": ctx.subject?.lastName,
    "destinataire.nom_complet": [ctx.recipient.civility, ctx.recipient.firstName, ctx.recipient.lastName].filter(Boolean).join(" ") || null,
    "destinataire.societe": ctx.recipient.company,
    "destinataire.service": ctx.recipient.service,
    "centre.nom": ctx.center?.name,
    "centre.telephone": ctx.center?.phone,
    "centre.adresse": ctx.center?.address,
    "societe.nom": ctx.sender.businessName,
    "signataire.nom": ctx.sender.signatory,
    "dossier.reference_publique": ctx.subject?.publicReference,
    "date.jour": new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", dateStyle: "long" }).format(new Date(`${ctx.today}T12:00:00Z`)),
  };
  const out: Record<string, string> = {};
  for (const k of allowed) {
    const c = fieldCategory(k);
    if (c === "health" || c === "sensitive") {
      if (opts.skipSensitive) continue;
      throw new PostalError("SENSITIVE_BLOCKED", `Variable ${k} non résolue automatiquement : saisie habilitée requise`);
    }
    const v = values[k];
    // Erreur bloquante, jamais un champ vide silencieux (§4.4).
    if (v === null || v === undefined || v === "") throw new PostalError("VALIDATION", `Valeur manquante pour ${k}`, { field: k });
    out[k] = v;
  }
  return out;
}

export function renderText(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g, (_, k: string) => {
    const v = values[k];
    if (v === undefined) throw new PostalError("VALIDATION", `Variable ${k} sans valeur`);
    return v;
  });
}

/**
 * Détection textuelle de contenu santé : filet de sécurité (pas une
 * classification fiable). Sert notamment à refuser un `ai_context` douteux.
 */
const HEALTH_TERMS = [
  "audiogramme", "audition", "auditif", "auditive", "surdité", "sourd", "appareil auditif", "appareillage", "prothèse", "acouphène",
  "ordonnance", "prescription", "diagnostic", "pathologie", "traitement", "ophtalm", "dioptrie", "myopie", "presbytie", "glaucome",
  "mdph", "handicap", "invalidité", "sécurité sociale", "nir", "cpam", "mutuelle", "ald", "certificat médical", "compte rendu",
];

export function detectHealthTerms(text: string): string[] {
  const t = text.toLowerCase();
  return HEALTH_TERMS.filter((w) => new RegExp(`(^|[^a-zà-ÿ])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(t));
}
