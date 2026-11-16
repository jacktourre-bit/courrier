/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Les erreurs du module. Quand quelque chose est refusé (droit manquant, donnée invalide,
 * envoi bloqué), le code « lance » une PostalError avec un code court (ex. FORBIDDEN) que
 * l'écran peut afficher clairement.
 * ═══════════════════════════════════════════════════════════════════════════
 */
/**
 * Erreurs métier typées. `code` est stable et exploitable par l'interface ;
 * `message` ne doit jamais contenir de donnée personnelle ni de secret.
 */
export type ErrorCode =
  | "MODULE_DISABLED"
  | "PROVIDER_DISABLED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "COMPLIANCE_BLOCKED"
  | "SENSITIVE_BLOCKED"
  | "INVALID_TRANSITION"
  | "CONFLICT"
  | "BUDGET_EXCEEDED"
  | "APPROVAL_REQUIRED"
  | "UNSUPPORTED"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "SSRF_BLOCKED"
  | "FILE_REJECTED";

const HTTP: Record<ErrorCode, number> = {
  MODULE_DISABLED: 503,
  PROVIDER_DISABLED: 503,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  COMPLIANCE_BLOCKED: 422,
  SENSITIVE_BLOCKED: 422,
  INVALID_TRANSITION: 409,
  CONFLICT: 409,
  BUDGET_EXCEEDED: 422,
  APPROVAL_REQUIRED: 422,
  UNSUPPORTED: 501,
  PROVIDER_ERROR: 502,
  RATE_LIMITED: 429,
  SSRF_BLOCKED: 400,
  FILE_REJECTED: 422,
};

export class PostalError extends Error {
  readonly httpStatus: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PostalError";
    this.httpStatus = HTTP[code];
  }
}

export const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): never => {
  throw new PostalError(code, message, details);
};

// EN CLAIR : Vérifie une condition ; si elle est fausse, arrête tout avec une erreur explicite.
export function assert(cond: unknown, code: ErrorCode, message: string, details?: Record<string, unknown>): asserts cond {
  if (!cond) throw new PostalError(code, message, details);
}
