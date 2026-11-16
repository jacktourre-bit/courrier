/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Qui est l'utilisateur et qu'a-t-il le droit de faire. Chaque requête indique la société
 * active ; seuls les droits de l'utilisateur dans cette société s'appliquent. Sans double
 * authentification (MFA), les droits d'administration et de santé sont retirés.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { createHmac } from "node:crypto";
import { ROLE_PERMISSIONS, type Role } from "../domain/policy.js";
import type { Scope } from "../domain/types.js";
import { PostalError } from "../lib/errors.js";
import { safeEqual } from "../lib/util.js";

/**
 * Identité de l'appelant. L'application hôte fournit son propre `Authenticator`
 * (session, OIDC, Supabase Auth…). Les rôles sont portés PAR SOCIÉTÉ : la
 * requête désigne la société active (en-tête X-Legal-Entity-Id) et seules les
 * permissions de cette société s'appliquent.
 */
export interface Membership {
  legalEntityId: string;
  roles: Role[];
  centerIds: string[] | "*";
  /** Permissions nominatives supplémentaires (ex. postal.approve_sensitive accordée par le DPO). */
  extraPermissions?: string[];
}

export interface Principal {
  userId: string;
  tenantId: string;
  memberships: Membership[];
  mfa: boolean;
}

export interface Authenticator {
  authenticate(headers: Headers): Promise<Principal | null>;
}

// EN CLAIR : Calcule le périmètre (société, centres) et la liste des droits de l'utilisateur pour la
// société choisie.
export function scopeFor(p: Principal, legalEntityId: string | null): { scope: Scope; permissions: Set<string> } {
  if (!legalEntityId) throw new PostalError("VALIDATION", "En-tête X-Legal-Entity-Id requis");
  const m = p.memberships.find((x) => x.legalEntityId === legalEntityId);
  if (!m) throw new PostalError("FORBIDDEN", "Société non autorisée pour cet utilisateur");
  const perms = new Set<string>([...m.roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []), ...(m.extraPermissions ?? [])]);
  // MFA exigée pour l'administration et les envois sensibles (§13.3).
  if (!p.mfa) for (const x of ["postal.config.manage", "postal.sensitive.authorize", "postal.approve_sensitive"]) perms.delete(x);
  return { scope: { tenantId: p.tenantId, legalEntityIds: [legalEntityId], centerIds: m.centerIds, userId: p.userId }, permissions: perms };
}

// EN CLAIR : Vérifie le jeton de connexion (JWT) : signature, date d'expiration, émetteur.
/**
 * Authentificateur JWT HS256 autonome (déploiement sans hôte). Claims attendus :
 * sub, tid, exp, mfa (bool), ent: [{ id, roles, centers }], iss, aud.
 */
export function hs256Authenticator(secret: string, opts: { issuer: string; audience: string; clock?: () => number }): Authenticator {
  if (secret.length < 32) throw new Error("Secret JWT trop court");
  return {
    async authenticate(headers) {
      const h = headers.get("authorization");
      if (!h?.startsWith("Bearer ")) return null;
      const parts = h.slice(7).split(".");
      if (parts.length !== 3) return null;
      const [head, body, sig] = parts as [string, string, string];
      let header: { alg?: string };
      let claims: Record<string, unknown>;
      try {
        header = JSON.parse(Buffer.from(head, "base64url").toString());
        claims = JSON.parse(Buffer.from(body, "base64url").toString());
      } catch {
        return null;
      }
      if (header.alg !== "HS256") return null;
      const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
      if (!safeEqual(expected, sig)) return null;
      const now = Math.floor((opts.clock?.() ?? Date.now()) / 1000);
      if (typeof claims.exp !== "number" || claims.exp < now) return null;
      if (claims.iss !== opts.issuer || claims.aud !== opts.audience) return null;
      if (typeof claims.sub !== "string" || typeof claims.tid !== "string" || !Array.isArray(claims.ent)) return null;
      const memberships: Membership[] = (claims.ent as { id: string; roles: Role[]; centers?: string[] | "*"; perms?: string[] }[])
        .filter((e) => typeof e.id === "string" && Array.isArray(e.roles))
        .map((e) => ({ legalEntityId: e.id, roles: e.roles.filter((r) => r in ROLE_PERMISSIONS), centerIds: e.centers ?? "*", extraPermissions: e.perms ?? [] }));
      return { userId: claims.sub, tenantId: claims.tid, memberships, mfa: claims.mfa === true };
    },
  };
}

// EN CLAIR : Fabrique un jeton (utilisé dans les tests).
export function signHs256(secret: string, claims: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
