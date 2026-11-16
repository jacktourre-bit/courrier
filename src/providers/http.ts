import type { FailureKind, ProviderResult } from "./types.js";

export interface HttpCallOptions {
  method: "GET" | "POST" | "DELETE" | "PATCH";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** L'appel crée une commande : un échec ambigu devient UNKNOWN, jamais RETRYABLE. */
  creates: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Interprétation spécifique d'un statut HTTP par le prestataire. */
  classify?: (status: number, body: unknown) => FailureKind | null;
}

/** Erreurs réseau où la requête n'a, avec certitude, pas atteint le serveur. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

function errCode(e: unknown): string | undefined {
  const any = e as { code?: string; cause?: { code?: string } };
  return any?.cause?.code ?? any?.code;
}

function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

/** Message prestataire tronqué : il peut contenir des données, on n'en garde que le début. */
const safeMsg = (body: unknown, status: number): string => {
  const m = (body as { message?: unknown; error?: unknown })?.message ?? (body as { error?: unknown })?.error;
  return typeof m === "string" ? m.slice(0, 160) : `HTTP ${status}`;
};

export async function httpJson<T>(o: HttpCallOptions): Promise<ProviderResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(o.url, {
      method: o.method,
      headers: { Accept: "application/json", ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}), ...o.headers },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal: ctrl.signal,
      redirect: "error",
    });
  } catch (e) {
    clearTimeout(timer);
    const code = errCode(e);
    if (code && NOT_SENT.has(code)) return { ok: false, kind: "RETRYABLE", message: `réseau: ${code}` };
    // Timeout ou coupure après émission : issue inconnue.
    return { ok: false, kind: o.creates ? "UNKNOWN" : "RETRYABLE", message: `réseau: ${code ?? (e as Error)?.name ?? "erreur"}` };
  }
  clearTimeout(timer);
  let body: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 160) };
    }
  }
  if (res.ok) return { ok: true, value: body as T };
  const custom = o.classify?.(res.status, body);
  if (custom) return { ok: false, kind: custom, message: safeMsg(body, res.status), httpStatus: res.status };
  const s = res.status;
  if (s === 429) return { ok: false, kind: "RATE_LIMITED", message: "limite de débit", httpStatus: s, retryAfterMs: retryAfterMs(res.headers.get("retry-after")) ?? 60_000 };
  if (s === 401) return { ok: false, kind: "AUTH", message: safeMsg(body, s), httpStatus: s };
  if (s === 402) return { ok: false, kind: "INSUFFICIENT_FUNDS", message: safeMsg(body, s), httpStatus: s };
  if (s >= 500) return { ok: false, kind: o.creates ? "UNKNOWN" : "RETRYABLE", message: safeMsg(body, s), httpStatus: s };
  const fields = body && typeof body === "object" ? Object.keys((body as { validation_errors?: object }).validation_errors ?? {}) : [];
  return { ok: false, kind: "DEFINITIVE", message: safeMsg(body, s), httpStatus: s, fields };
}
