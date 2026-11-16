import type {
  ContactPreference,
  Organization,
  ProviderName,
  Purpose,
  RecipientAddress,
  SenderProfile,
  Sensitivity,
  SensitiveAuthorization,
  Subject,
  Template,
  TemplateVersion,
} from "../domain/types.js";
import { validateAddress } from "../domain/address.js";
import { isSensitive } from "../domain/policy.js";
import { daysBetween } from "../lib/util.js";

/**
 * Moteur Compliance (§5.1). Fonction pure : toutes les données sont chargées
 * par l'appelant. Le résultat liste TOUS les blocages (pas seulement le premier)
 * pour un affichage clair à l'utilisateur.
 */
export interface Blocker {
  code: string;
  message: string;
}

export interface ComplianceInput {
  purpose: Purpose;
  provider: ProviderName;
  legalEntityId: string;
  subject: Subject | null;
  subjectIsPatient: boolean;
  recipientAddress: RecipientAddress | null;
  organization: Organization | null;
  sender: SenderProfile | null;
  template: Template | null;
  templateVersion: TemplateVersion | null;
  preferences: ContactPreference[];
  /** Préférence spécifique exigée (ex. `birthday` en automatisation). */
  requiredPreference?: ContactPreference["purpose"];
  requireExplicitOptIn: boolean;
  duplicateDispatchId: string | null;
  sensitivity: Sensitivity;
  sensitiveFlag: boolean;
  sensitiveAuthorization: SensitiveAuthorization | null;
  automated: boolean;
  allowMinors: boolean;
  addressMaxAgeDays: number | null;
  today: string;
}

const PROSPECT: Purpose[] = ["marketing"];

export function evaluateCompliance(i: ComplianceInput): { allowed: boolean; blockers: Blocker[]; warnings: string[] } {
  const b: Blocker[] = [];
  const w: string[] = [];
  const add = (code: string, message: string) => b.push({ code, message });

  // Émetteur
  if (!i.sender || !i.sender.active) add("sender_missing", "Profil expéditeur absent ou inactif");
  else if (i.sender.legalEntityId !== i.legalEntityId) add("sender_entity_mismatch", "Profil expéditeur d'une autre société");

  // Destinataire et adresse
  if (!i.recipientAddress) add("address_missing", "Adresse destinataire absente");
  else {
    if (i.recipientAddress.legalEntityId !== i.legalEntityId) add("address_entity_mismatch", "Adresse rattachée à une autre société");
    if (i.recipientAddress.validityStatus === "invalid" || i.recipientAddress.validityStatus === "npai") add("address_invalid", "Adresse marquée invalide / NPAI");
    for (const issue of validateAddress(i.recipientAddress.addressJson)) add(`address_${issue.code}`, issue.message);
    if (i.addressMaxAgeDays !== null) {
      const v = i.recipientAddress.verifiedAt;
      if (!v) add("address_unverified", "Adresse jamais vérifiée");
      else if (daysBetween(v.slice(0, 10), i.today) > i.addressMaxAgeDays) add("address_stale", "Adresse trop ancienne pour un envoi automatique");
    }
  }
  if (i.organization) {
    if (!i.organization.active) add("org_inactive", "Organisme inactif");
    if (!i.organization.verifiedAt) add("org_unverified", "Adresse d'organisme non vérifiée");
    if (!i.organization.channelPolicy.postalAccepted) add("org_channel", "Le canal postal n'est pas le canal accepté par cet organisme");
  }

  // Personne concernée
  if (i.subject) {
    if (i.subject.legalEntityId !== i.legalEntityId) add("subject_entity_mismatch", "Personne rattachée à une autre société (pas de propagation inter-sociétés)");
    if (i.subject.deceased) add("subject_deceased", "Personne signalée décédée");
    if (i.subject.archived) add("subject_archived", "Dossier archivé");
    if (i.subject.litigation && (i.purpose === "relationship" || i.purpose === "marketing")) add("subject_litigation", "Contentieux en cours : pas de courrier relationnel");
    if ((i.purpose === "relationship" || i.purpose === "marketing") && i.automated && !i.allowMinors) {
      if (!i.subject.birthDate) add("subject_age_unknown", "Âge inconnu : exclusion par défaut de l'automatisation");
      else if (age(i.subject.birthDate, i.today) < 18) add("subject_minor", "Mineur exclu du programme relationnel automatique");
    }
  }

  // Préférences / opposition (par société, par finalité)
  // La plus récente fait foi ; à horodatage égal, l'opposition l'emporte (choix prudent).
  const pref = (p: ContactPreference["purpose"]) =>
    i.preferences
      .filter((x) => x.purpose === p && x.channel === "postal" && x.legalEntityId === i.legalEntityId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || Number(a.allowed) - Number(b.allowed))[0];
  const main = pref(i.purpose);
  if (main && !main.allowed) add("opposition", `Opposition enregistrée pour la finalité ${i.purpose}`);
  if (i.requiredPreference) {
    const p = pref(i.requiredPreference);
    if (p && !p.allowed) add("opposition_specific", `Opposition enregistrée (${i.requiredPreference})`);
    if (!p && i.requireExplicitOptIn) add("optin_missing", `Accord explicite requis (${i.requiredPreference})`);
  }
  if (PROSPECT.includes(i.purpose) && !main) w.push("Prospection : vérifier l'information préalable et le moyen d'opposition");
  if ((i.purpose === "relationship" || i.purpose === "marketing") && i.subjectIsPatient && !main && !i.requiredPreference) {
    if (i.requireExplicitOptIn) add("optin_missing", "Accord explicite requis pour un courrier relationnel à un patient");
  }

  // Modèle
  if (!i.template || !i.templateVersion) add("template_missing", "Modèle absent");
  else {
    if (i.template.legalEntityId !== i.legalEntityId) add("template_entity_mismatch", "Modèle d'une autre société");
    if (i.templateVersion.status !== "approved") add("template_not_approved", "Version de modèle non approuvée");
    if (i.template.purpose !== i.purpose) add("template_purpose_mismatch", "Finalité du modèle incompatible");
    if (i.template.provider !== i.provider) add("template_provider_mismatch", "Modèle prévu pour un autre prestataire");
  }

  // Doublon
  if (i.duplicateDispatchId) add("duplicate", "Un envoi identique existe déjà pour cet événement");

  // Sensibilité (§13.2) : blocage complet AVANT tout appel prestataire.
  if (isSensitive(i.sensitivity)) {
    if (!i.sensitiveFlag) add("sensitive_flag_off", "Données sensibles/santé : envoi externe interdit (SENSITIVE_POSTAL_ALLOWED désactivé)");
    else if (!i.sensitiveAuthorization) add("sensitive_not_authorized", "Aucune autorisation documentée pour ce prestataire, ce modèle et cette entité");
    else if (i.sensitiveAuthorization.expiresAt && i.sensitiveAuthorization.expiresAt.slice(0, 10) < i.today) add("sensitive_authorization_expired", "Autorisation sensible expirée");
    if (i.provider === "manuscry") add("sensitive_manuscry", "Aucune donnée sensible vers Manuscry");
  }

  return { allowed: b.length === 0, blockers: b, warnings: w };
}

export function age(birthDate: string, today: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}
