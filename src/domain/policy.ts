import type {
  ApprovalStep,
  AttachmentCategory,
  Dispatch,
  Organization,
  PostageClass,
  ProviderName,
  Purpose,
  Sensitivity,
  SubjectType,
} from "./types.js";
import { isRegistered, maxSensitivity } from "./types.js";
import { fieldsSensitivity, detectHealthTerms, RELATIONAL_PURPOSES } from "./merge-fields.js";
import { PostalError } from "../lib/errors.js";

// ---------------------------------------------------------------- Sensibilité

const ATTACHMENT_SENSITIVITY: Record<AttachmentCategory, Sensitivity> = {
  administrative: "personal_non_health",
  invoice: "personal_non_health",
  quote: "personal_non_health",
  contract: "personal_non_health",
  other: "personal_non_health",
  identity: "personal_sensitive",
  medical_report: "health",
  audiogram: "health",
  prescription: "health",
  certificate: "health",
  mdph_file: "health",
};

export const HEALTH_ORG_CATEGORIES: Organization["category"][] = ["cpam", "mdph", "mutuelle", "caisse"];

export interface SensitivityInput {
  declared: Sensitivity;
  mergeFieldKeys: string[];
  attachments: { category: AttachmentCategory; declared: Sensitivity }[];
  subjectType: SubjectType;
  /** Le courrier concerne un patient (même adressé à un organisme). */
  concernsPatient: boolean;
  recipientOrgCategory: Organization["category"] | null;
  freeTexts: string[];
  purpose: Purpose;
}

/**
 * Classification conservatrice : le niveau retenu est le maximum de toutes les
 * sources. Un courrier concernant un patient et adressé à un organisme de
 * santé/couverture révèle une relation de soin -> `health`.
 */
export function classifySensitivity(i: SensitivityInput): { level: Sensitivity; reasons: string[] } {
  const reasons: string[] = [];
  const levels: Sensitivity[] = [i.declared, fieldsSensitivity(i.mergeFieldKeys)];
  for (const a of i.attachments) {
    const s = maxSensitivity(a.declared, ATTACHMENT_SENSITIVITY[a.category]);
    if (s === "health") reasons.push(`pièce ${a.category}`);
    levels.push(s);
  }
  if (i.concernsPatient && i.recipientOrgCategory && HEALTH_ORG_CATEGORIES.includes(i.recipientOrgCategory)) {
    reasons.push(`patient + organisme ${i.recipientOrgCategory}`);
    levels.push("health");
  }
  const hits = i.freeTexts.flatMap(detectHealthTerms);
  if (hits.length && (RELATIONAL_PURPOSES.includes(i.purpose) || i.concernsPatient)) {
    reasons.push(`termes santé détectés (${[...new Set(hits)].slice(0, 5).join(", ")})`);
    levels.push("health");
  }
  return { level: maxSensitivity(...levels), reasons };
}

export const isSensitive = (s: Sensitivity): boolean => s === "health" || s === "personal_sensitive";

// ------------------------------------------------------------------- Routage

export interface RoutingInput {
  purpose: Purpose;
  rendering: "handwritten" | "formal";
  postageClass: PostageClass;
  hasAttachments: boolean;
  needsProof: boolean;
}

/**
 * Routage serveur (§6). Pas de bascule silencieuse : si le prestataire choisi
 * est indisponible, l'envoi attend en file, il n'est jamais rerouté.
 */
export function routeProvider(r: RoutingInput): ProviderName {
  if (r.rendering === "handwritten") {
    if (!RELATIONAL_PURPOSES.includes(r.purpose)) throw new PostalError("VALIDATION", "Le rendu manuscrit est réservé aux finalités relationnelles/marketing");
    if (r.hasAttachments || r.needsProof || r.postageClass !== "handwritten") {
      throw new PostalError("UNSUPPORTED", "Annexes, preuves et recommandés non documentés chez Manuscry");
    }
    return "manuscry";
  }
  if (r.postageClass === "handwritten") throw new PostalError("VALIDATION", "Affranchissement incompatible avec un document formel");
  return "servicepostal";
}

// ------------------------------------------------------- Matrice d'approbation

export interface RequiredStep {
  step: ApprovalStep;
  permission: string;
  /** L'approbateur doit être différent du créateur. */
  fourEyes: boolean;
}

export function approvalPolicyFor(d: Pick<Dispatch, "purpose" | "postageClass" | "sensitivity" | "sourceType">, preapprovedCampaign: boolean): {
  policy: Dispatch["approvalPolicy"];
  steps: RequiredStep[];
} {
  const steps: RequiredStep[] = [];
  let policy: Dispatch["approvalPolicy"];
  const legal = d.purpose === "legal" || isRegistered(d.postageClass);
  if (preapprovedCampaign && RELATIONAL_PURPOSES.includes(d.purpose) && !legal && !isSensitive(d.sensitivity)) {
    return { policy: "campaign_preapproved", steps: [] };
  }
  if (legal) {
    policy = "legal_double";
    steps.push({ step: "review", permission: "postal.approve", fourEyes: true });
    steps.push({ step: "final_legal", permission: "postal.approve_legal", fourEyes: true });
  } else if (d.purpose === "administrative" || d.purpose === "transactional") {
    policy = "four_eyes";
    steps.push({ step: "final", permission: "postal.approve", fourEyes: true });
  } else {
    policy = "single";
    steps.push({ step: "final", permission: "postal.approve", fourEyes: false });
  }
  if (isSensitive(d.sensitivity)) {
    policy = "sensitive";
    steps.push({ step: "sensitive", permission: "postal.approve_sensitive", fourEyes: true });
  }
  return { policy, steps };
}

// --------------------------------------------------------------------- Rôles

export const ROLES = ["assistante", "audioprothesiste", "manager", "administrateur", "direction", "audit"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  assistante: ["postal.read", "postal.draft", "postal.submit"],
  audioprothesiste: ["postal.read", "postal.draft", "postal.submit", "postal.approve"],
  manager: ["postal.read", "postal.draft", "postal.submit", "postal.approve", "postal.cancel", "postal.campaign.manage", "postal.templates.manage", "postal.organizations.manage", "postal.directory.manage", "postal.evidence.read"],
  direction: [
    "postal.read", "postal.draft", "postal.submit", "postal.approve", "postal.approve_legal", "postal.cancel", "postal.campaign.manage",
    "postal.campaign.approve", "postal.templates.manage", "postal.templates.approve", "postal.budget.override", "postal.organizations.manage",
    "postal.evidence.read", "postal.export",
  ],
  administrateur: ["postal.read", "postal.config.manage", "postal.templates.manage", "postal.organizations.manage", "postal.directory.manage", "postal.audit.read"],
  audit: ["postal.read", "postal.audit.read", "postal.evidence.read"],
};
// Permissions P4, attribuées à AUCUN rôle par défaut, accordées nominativement après validation DPO (§13.2) :
//   postal.sensitive.authorize (enregistrer une autorisation prestataire), postal.approve_sensitive (étape d'approbation),
//   postal.sensitive.enter (saisir NIR / données de santé), postal.sensitive.attach (joindre une pièce médicale),
//   postal.sensitive.read (lire un contenu sensible), postal.retention.manage (durées de conservation).
