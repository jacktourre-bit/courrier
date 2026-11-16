/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Téléchargement sécurisé des fichiers que les prestataires mettent à disposition (aperçu,
 * preuve de dépôt, AR). On n'accepte que du HTTPS, vers des domaines autorisés, jamais vers
 * une adresse interne du serveur (protection « SSRF »).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PostalError } from "./errors.js";

/**
 * Téléchargement côté serveur des URLs retournées par un prestataire (aperçu,
 * preuve de dépôt, AR scanné). Protection SSRF : HTTPS uniquement, hôte dans
 * une liste blanche, résolution DNS refusant les plages privées, taille bornée,
 * pas de redirection suivie automatiquement.
 *
 * Limite connue : la résolution DNS précède la connexion (fenêtre de
 * DNS rebinding). Pour la supprimer, épingler l'IP via un Agent dédié.
 */
export interface SafeFetchOptions {
  allowedHostSuffixes: string[];
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Désactive la vérification DNS (tests uniquement). */
  skipDnsCheck?: boolean;
}

// EN CLAIR : Dit si une adresse IP est interne (réseau privé, machine locale) : on refuse de s'y
// connecter.
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

// EN CLAIR : Vérifie que le domaine appartient à la liste blanche (ex. servicepostal.com).
export function hostAllowed(host: string, suffixes: string[]): boolean {
  const h = host.toLowerCase();
  return suffixes.some((s) => {
    const suf = s.toLowerCase().replace(/^\*?\./, "");
    return h === suf || h.endsWith(`.${suf}`);
  });
}

// EN CLAIR : Télécharge le fichier après toutes les vérifications, avec une taille et une durée
// maximales.
export async function safeDownload(rawUrl: string, opts: SafeFetchOptions): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PostalError("SSRF_BLOCKED", "URL invalide");
  }
  if (url.protocol !== "https:") throw new PostalError("SSRF_BLOCKED", "Seul HTTPS est autorisé");
  if (url.username || url.password) throw new PostalError("SSRF_BLOCKED", "Identifiants dans l'URL refusés");
  if (isIP(url.hostname)) throw new PostalError("SSRF_BLOCKED", "Adresse IP littérale refusée");
  if (!hostAllowed(url.hostname, opts.allowedHostSuffixes)) throw new PostalError("SSRF_BLOCKED", "Hôte non autorisé", { host: url.hostname });
  if (!opts.skipDnsCheck) {
    const addrs = await lookup(url.hostname, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new PostalError("SSRF_BLOCKED", "Résolution vers une adresse privée");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { redirect: "manual", signal: ctrl.signal });
    if (res.status >= 300 && res.status < 400) throw new PostalError("SSRF_BLOCKED", "Redirection refusée");
    if (!res.ok) throw new PostalError("PROVIDER_ERROR", `Téléchargement refusé (${res.status})`);
    const max = opts.maxBytes ?? 25 * 1024 * 1024;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > max) throw new PostalError("FILE_REJECTED", "Fichier trop volumineux");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) throw new PostalError("FILE_REJECTED", "Fichier trop volumineux");
    return { bytes: buf, contentType: res.headers.get("content-type") };
  } finally {
    clearTimeout(timer);
  }
}
