/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Petits outils utilisés partout : identifiants, empreintes (hachages), montants en centimes,
 * dates à l'heure de Paris.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const uuid = (): string => randomUUID();

// EN CLAIR : Fabrique une référence du type CORR-xxxx. C'est elle qu'on donne aux prestataires : elle
// ne révèle rien sur le patient.
/** Identifiant opaque transmis aux prestataires (jamais l'ID patient). */
export const opaqueRef = (prefix = "CORR"): string => `${prefix}-${randomBytes(9).toString("base64url")}`;

// EN CLAIR : Calcule l'« empreinte » d'un fichier : une suite de 64 caractères qui change si un seul
// octet du fichier change. Sert à prouver qu'un document n'a pas été modifié.
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

// EN CLAIR : Empreinte d'un objet (adresse, options…) calculée toujours dans le même ordre, pour que
// deux contenus identiques donnent la même empreinte.
/** Hash canonique d'un objet JSON (clés triées) : sert à lier une approbation à un contenu précis. */
export const canonicalHash = (value: unknown): string => sha256(canonicalJson(value));

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

// EN CLAIR : Compare deux secrets sans fuite d'information par le temps de calcul (protection contre
// certaines attaques).
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// EN CLAIR : Transforme un prix « 7.39 » en 739 centimes. On ne calcule jamais l'argent avec des
// virgules (erreurs d'arrondi).
/** Montant décimal prestataire (ex. 7.42 € HT) -> centimes entiers, sans dérive flottante. */
export const toCents = (amount: number | string | null | undefined): number | null => {
  if (amount === null || amount === undefined || amount === "") return null;
  const n = typeof amount === "string" ? Number(amount.replace(",", ".")) : amount;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
};

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export const TZ = "Europe/Paris";

// EN CLAIR : Donne la date du jour à Paris (AAAA-MM-JJ), même si le serveur est réglé sur une autre
// heure.
/** Date civile (YYYY-MM-DD) dans le fuseau Europe/Paris. */
export function parisDate(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Heure locale Paris en minutes depuis minuit. */
export function parisMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

// EN CLAIR : Ajoute (ou retire) des jours à une date.
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// EN CLAIR : Nombre de jours entre deux dates.
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function monthKey(d: Date): string {
  return parisDate(d).slice(0, 7);
}

export const truncate = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max));
