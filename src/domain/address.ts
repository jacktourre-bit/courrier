import type { PostalAddress } from "./types.js";

export interface AddressIssue {
  field: keyof PostalAddress | "lines";
  code: string;
  message: string;
}

/** Limite documentée par Service Postal : 38 caractères par ligne d'adresse. */
export const MAX_LINE = 38;

/** Civilités acceptées par Service Postal (format long ou court) ; toute autre valeur y renvoie une erreur. */
export const SP_CIVILITIES = new Set([
  "Mademoiselle", "Mlle", "Madame", "Mme", "Monsieur", "M.", "Docteur", "Dr", "Professeur", "Pr", "Maître", "Me", "Monseigneur", "Mgr", "Veuve", "Vve",
]);

const POSTCODE: Record<string, RegExp> = {
  FR: /^(?:0[1-9]|[1-8]\d|9[0-8])\d{3}$/,
  MC: /^980\d{2}$/,
  BE: /^\d{4}$/,
  CH: /^\d{4}$/,
  LU: /^\d{4}$/,
  DE: /^\d{5}$/,
  ES: /^\d{5}$/,
  IT: /^\d{5}$/,
};

export function normalizeAddress(a: PostalAddress): PostalAddress {
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim() || null;
  return {
    civility: clean(a.civility),
    firstName: clean(a.firstName),
    lastName: clean(a.lastName),
    company: clean(a.company),
    service: clean(a.service),
    line1: clean(a.line1) ?? "",
    line2: clean(a.line2),
    line3: clean(a.line3),
    postalCode: (a.postalCode ?? "").replace(/\s+/g, "").toUpperCase(),
    city: (clean(a.city) ?? "").toUpperCase(),
    country: (a.country ?? "").trim().toUpperCase(),
  };
}

export function recipientName(a: PostalAddress): string {
  return [a.civility, a.firstName, a.lastName].filter(Boolean).join(" ").trim();
}

export function validateAddress(input: PostalAddress): AddressIssue[] {
  const a = normalizeAddress(input);
  const issues: AddressIssue[] = [];
  if (!a.lastName && !a.company) issues.push({ field: "lastName", code: "missing_name", message: "Nom ou raison sociale requis" });
  if (!a.line1) issues.push({ field: "line1", code: "missing_line1", message: "Ligne d'adresse requise" });
  if (!a.postalCode) issues.push({ field: "postalCode", code: "missing_postcode", message: "Code postal requis" });
  if (!a.city) issues.push({ field: "city", code: "missing_city", message: "Ville requise" });
  if (!/^[A-Z]{2}$/.test(a.country)) issues.push({ field: "country", code: "invalid_country", message: "Pays ISO alpha-2 requis" });
  const re = POSTCODE[a.country];
  if (a.postalCode && re && !re.test(a.postalCode)) issues.push({ field: "postalCode", code: "invalid_postcode", message: "Code postal invalide pour le pays" });
  for (const f of ["line1", "line2", "line3", "city", "company"] as const) {
    const v = a[f];
    if (v && v.length > MAX_LINE) issues.push({ field: f, code: "line_too_long", message: `Ligne > ${MAX_LINE} caractères` });
  }
  if (recipientName(a).length > MAX_LINE) issues.push({ field: "lines", code: "name_too_long", message: `Nom destinataire > ${MAX_LINE} caractères` });
  if (a.civility && !SP_CIVILITIES.has(a.civility)) issues.push({ field: "civility", code: "invalid_civility", message: "Civilité non reconnue" });
  return issues;
}

export const isDomestic = (a: PostalAddress): boolean => ["FR", "MC"].includes(a.country.toUpperCase());

/** Nom de pays attendu par Service Postal (liste en français de l'OpenAPI). Liste restreinte volontairement. */
export const SP_COUNTRY_NAMES: Record<string, string> = {
  FR: "France",
  MC: "Monaco",
  BE: "Belgique",
  CH: "Suisse",
  LU: "Luxembourg",
  DE: "Allemagne",
  ES: "Espagne",
  IT: "Italie",
  GB: "Royaume-Uni",
  PT: "Portugal",
  NL: "Pays-Bas",
};
