import { beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../../src/api/app.js";
import { hs256Authenticator, signHs256 } from "../../src/api/auth.js";
import { harness, seed, LE_A, LE_B, T, type Harness, type Seed } from "../helpers.js";
import { runOutboxOnce } from "../../src/services/worker.js";

const SECRET = "x".repeat(40);
let h: Harness;
let s: Seed;
let app: ReturnType<typeof createApi>;

const token = (sub: string, ent: { id: string; roles: string[]; perms?: string[] }[], extra: Record<string, unknown> = {}) =>
  signHs256(SECRET, { sub, tid: T, ent, iss: "saas", aud: "postal", exp: Math.floor(Date.now() / 1000) + 600, mfa: true, ...extra });

const call = (method: string, path: string, opts: { tok?: string; le?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  app.request(`/api/postal${path}`, {
    method,
    headers: {
      ...(opts.tok ? { authorization: `Bearer ${opts.tok}` } : {}),
      ...(opts.le ? { "x-legal-entity-id": opts.le } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

beforeEach(async () => {
  h = harness();
  s = await seed(h);
  app = createApi({ deps: h.deps, auth: hs256Authenticator(SECRET, { issuer: "saas", audience: "postal" }) });
});

const createBody = () => ({
  legal_entity_id: LE_A, center_id: null, source_type: "organization_file", subject: { type: "organization", id: s.orgId },
  recipient: { organization_id: s.orgId }, purpose: "administrative", template_version_id: s.formalVersionId, postage_class: "ecopli",
});

describe("API interne", () => {
  it("401 sans jeton, jeton falsifié ou expiré", async () => {
    expect((await call("GET", "/dispatches", { le: LE_A })).status).toBe(401);
    const bad = token("u", [{ id: LE_A, roles: ["direction"] }]).slice(0, -2) + "xx";
    expect((await call("GET", "/dispatches", { tok: bad, le: LE_A })).status).toBe(401);
    const expired = token("u", [{ id: LE_A, roles: ["direction"] }], { exp: 1 });
    expect((await call("GET", "/dispatches", { tok: expired, le: LE_A })).status).toBe(401);
  });

  it("parcours complet par l'API avec rôles distincts (test 25)", async () => {
    const assistante = token("assistante-1", [{ id: LE_A, roles: ["assistante"] }]);
    const manager = token("manager-1", [{ id: LE_A, roles: ["manager"] }]);
    const auditeur = token("audit-1", [{ id: LE_A, roles: ["audit"] }]);
    // Idempotency-Key obligatoire
    expect((await call("POST", "/dispatches", { tok: assistante, le: LE_A, body: createBody() })).status).toBe(422);
    const created = await call("POST", "/dispatches", { tok: assistante, le: LE_A, body: createBody(), headers: { "idempotency-key": "k-0123456789abcdef" } });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as any).data.id as string;
    expect((await call("POST", `/dispatches/${id}/preview`, { tok: assistante, le: LE_A })).status).toBe(200);
    expect((await call("POST", `/dispatches/${id}/submit`, { tok: assistante, le: LE_A })).status).toBe(200);
    // L'assistante ne peut pas approuver ; l'auditeur ne peut rien créer.
    expect((await call("POST", `/dispatches/${id}/approve`, { tok: assistante, le: LE_A, body: {} })).status).toBe(403);
    expect((await call("POST", "/dispatches", { tok: auditeur, le: LE_A, body: createBody(), headers: { "idempotency-key": "k-zzzz456789abcdef" } })).status).toBe(403);
    const ok = await call("POST", `/dispatches/${id}/approve`, { tok: manager, le: LE_A, body: {} });
    expect(ok.status).toBe(200);
    await runOutboxOnce(h.deps);
    const detail: any = await (await call("GET", `/dispatches/${id}`, { tok: auditeur, le: LE_A })).json();
    expect(detail.data.status).toBe("SUBMITTED");
    expect(detail.data).not.toHaveProperty("mergeValuesJson");
    expect(detail.approvals.map((a: { approverUserId: string }) => a.approverUserId)).toEqual(["manager-1"]);
    expect((await call("GET", "/audit", { tok: auditeur, le: LE_A })).status).toBe(200);
    expect((await call("GET", "/audit", { tok: manager, le: LE_A })).status).toBe(403);
  });

  it("isolement multi-sociétés : en-tête d'une société non autorisée refusé, données de A invisibles depuis B (test 21)", async () => {
    const a = token("ua", [{ id: LE_A, roles: ["direction"] }]);
    const b = token("ub", [{ id: LE_B, roles: ["direction"] }]);
    const created = await call("POST", "/dispatches", { tok: a, le: LE_A, body: createBody(), headers: { "idempotency-key": "k-iso456789abcdef0" } });
    const id = ((await created.json()) as any).data.id;
    expect((await call("GET", `/dispatches/${id}`, { tok: b, le: LE_A })).status).toBe(403);
    expect((await call("GET", `/dispatches/${id}`, { tok: b, le: LE_B })).status).toBe(404);
    const list: any = await (await call("GET", "/dispatches", { tok: b, le: LE_B })).json();
    expect(list.data).toHaveLength(0);
    // Création au nom d'une autre société avec le contexte B : refus.
    expect((await call("POST", "/dispatches", { tok: b, le: LE_B, body: createBody(), headers: { "idempotency-key": "k-iso2456789abcdef" } })).status).toBe(403);
  });

  it("réponses et logs sans secret ni document (test 23)", async () => {
    const admin = token("adm", [{ id: LE_A, roles: ["administrateur"] }]);
    const res = await (await call("GET", "/providers", { tok: admin, le: LE_A })).json();
    const txt = JSON.stringify(res);
    expect(txt).not.toMatch(/env:SP_KEY|webhookTokenHash|credentials/);
    const m = token("m", [{ id: LE_A, roles: ["direction"] }]);
    const created = await call("POST", "/dispatches", { tok: m, le: LE_A, body: createBody(), headers: { "idempotency-key": "k-log456789abcdef0" } });
    const id = ((await created.json()) as any).data.id;
    await call("POST", `/dispatches/${id}/preview`, { tok: m, le: LE_A });
    const logs = h.logs.join("\n");
    expect(logs).not.toContain(h.sp.apiKey);
    expect(logs).not.toContain("JVBER"); // début base64 d'un PDF
    expect(logs).not.toMatch(/https:\/\/cdn/);
  });

  it("MFA requise pour l'administration ; corps invalides rejetés (Zod strict)", async () => {
    const noMfa = token("adm", [{ id: LE_A, roles: ["administrateur"] }], { mfa: false });
    const r = await call("POST", "/providers", { tok: noMfa, le: LE_A, body: { legal_entity_id: LE_A, provider: "servicepostal", environment: "sandbox", credentials_secret_ref: "env:X" } });
    expect(r.status).toBe(403);
    const m = token("m", [{ id: LE_A, roles: ["direction"] }]);
    const bad = await call("POST", "/dispatches", { tok: m, le: LE_A, body: { ...createBody(), unexpected: 1 }, headers: { "idempotency-key": "k-bad456789abcdef0" } });
    expect(bad.status).toBe(422);
  });

  it("webhook : route publique à jeton, inconnu = 404", async () => {
    const r = await app.request(`/api/postal/webhooks/servicepostal/${"z".repeat(43)}`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
    const ok = await app.request(`/api/postal/webhooks/servicepostal/${s.spWebhookToken}`, { method: "POST", body: JSON.stringify({ uid: "l-00000000000000000000000000000abc" }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).result).toBe("unmatched");
  });

  it("module désactivé : API indisponible", async () => {
    h.deps.config.flags.POSTAL_MODULE_ENABLED = false;
    const m = token("m", [{ id: LE_A, roles: ["direction"] }]);
    expect((await call("GET", "/dispatches", { tok: m, le: LE_A })).status).toBe(503);
  });
});
