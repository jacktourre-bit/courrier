/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Les interrupteurs du module (« feature flags »). Tous sont éteints par défaut. Exemple :
 * SENSITIVE_POSTAL_ALLOWED autorise les courriers de santé ; hors production, les connexions «
 * production » sont toujours refusées pour qu'aucun vrai courrier ne parte pendant les tests.
 * ═══════════════════════════════════════════════════════════════════════════
 */
/**
 * Feature flags (§19.5). Tous désactivés par défaut : le module ne fait rien
 * tant qu'il n'est pas explicitement activé. `SENSITIVE_POSTAL_ALLOWED` ne
 * suffit pas seul : une autorisation documentée par entité/prestataire/modèle
 * est aussi exigée (table postal_sensitive_authorizations).
 */
export interface FeatureFlags {
  POSTAL_MODULE_ENABLED: boolean;
  MANUSCRY_ENABLED: boolean;
  SERVICEPOSTAL_ENABLED: boolean;
  BIRTHDAY_AUTOMATION_ENABLED: boolean;
  SENSITIVE_POSTAL_ALLOWED: boolean;
  POSTAL_BATCH_ENABLED: boolean;
  /** Garde-fou §19.6 : connexions `production` refusées tant que ce flag est faux. */
  POSTAL_PRODUCTION_PROVIDERS_ALLOWED: boolean;
}

export const FLAG_NAMES = [
  "POSTAL_MODULE_ENABLED",
  "MANUSCRY_ENABLED",
  "SERVICEPOSTAL_ENABLED",
  "BIRTHDAY_AUTOMATION_ENABLED",
  "SENSITIVE_POSTAL_ALLOWED",
  "POSTAL_BATCH_ENABLED",
  "POSTAL_PRODUCTION_PROVIDERS_ALLOWED",
] as const satisfies readonly (keyof FeatureFlags)[];

const truthy = (v: string | undefined) => v !== undefined && ["1", "true", "yes", "on"].includes(v.toLowerCase());

// EN CLAIR : Lit les interrupteurs dans la configuration du serveur (fichier .env).
export function flagsFromEnv(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  const flags = Object.fromEntries(FLAG_NAMES.map((n) => [n, truthy(env[n])])) as unknown as FeatureFlags;
  // Hors production, jamais d'envoi réel (§19.6) quel que soit le flag.
  if (env.NODE_ENV !== "production") flags.POSTAL_PRODUCTION_PROVIDERS_ALLOWED = false;
  return flags;
}

export const allOff = (): FeatureFlags => Object.fromEntries(FLAG_NAMES.map((n) => [n, false])) as unknown as FeatureFlags;

export interface ModuleConfig {
  flags: FeatureFlags;
  /** TVA appliquée sur la part « service » (l'affranchissement n'est pas soumis à TVA d'après Service Postal). */
  serviceVatRate: number;
  outboxMaxAttempts: number;
  /** Durée max d'un lien de téléchargement signé interne (secondes). */
  evidenceLinkTtlSeconds: number;
  allowUnscannedUploads: boolean;
  allowSelfApprovalRelationship: boolean;
}

// EN CLAIR : Lit toute la configuration (interrupteurs, TVA, nombre de tentatives…).
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ModuleConfig {
  return {
    flags: flagsFromEnv(env),
    serviceVatRate: Number(env.POSTAL_SERVICE_VAT_RATE ?? "0.20"),
    outboxMaxAttempts: Number(env.POSTAL_OUTBOX_MAX_ATTEMPTS ?? "8"),
    evidenceLinkTtlSeconds: Number(env.POSTAL_EVIDENCE_LINK_TTL ?? "300"),
    allowUnscannedUploads: env.NODE_ENV !== "production" && truthy(env.POSTAL_ALLOW_UNSCANNED_UPLOADS),
    allowSelfApprovalRelationship: truthy(env.POSTAL_ALLOW_SELF_APPROVAL_RELATIONSHIP),
  };
}
