/**
 * Logger JSON avec caviardage systématique. Aucune adresse, aucun document,
 * aucune clé API ni URL de document ne doit sortir dans les logs (cahier §13.3).
 */
const SENSITIVE_KEYS = [
  "apikey",
  "api_key",
  "authorization",
  "password",
  "secret",
  "token",
  "contenu_base64",
  "base64",
  "content",
  "body",
  "address",
  "adresse",
  "address_line1",
  "address_line2",
  "address_line3",
  "adresse_ligne1",
  "adresse_ligne2",
  "url",
  "scanurl",
  "email",
  "phone",
  "birthday_date",
  "birth_date",
  "first_name",
  "last_name",
  "prenom",
  "nom",
  "firstname",
  "lastname",
  "recipient_name",
  "ai_context",
];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      out[k] = SENSITIVE_KEYS.some((s) => lk === s || lk.endsWith(`_${s}`) || lk.includes(s)) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return "[url]";
    if (value.length > 500) return `[string:${value.length}]`;
  }
  return value;
}

type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`), minLevel: Level = "info"): Logger {
  const order: Level[] = ["debug", "info", "warn", "error"];
  const log = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    if (order.indexOf(level) < order.indexOf(minLevel)) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(meta ? (redact(meta) as object) : {}) }));
  };
  return {
    debug: (m, x) => log("debug", m, x),
    info: (m, x) => log("info", m, x),
    warn: (m, x) => log("warn", m, x),
    error: (m, x) => log("error", m, x),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
