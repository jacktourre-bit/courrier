import { beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../../src/api/app.js";
import { hs256Authenticator, signHs256 } from "../../src/api/auth.js";
import { harness, idem, seed, LE_A, T, type Harness, type Seed } from "../helpers.js";
import { approveDispatch, createDispatch, getDispatch, previewDispatch, requestApproval } from "../../src/services/dispatch-service.js";
import { runOutboxOnce } from "../../src/services/worker.js";
import { ingestWebhook } from "../../src/services/webhooks.js";
import { sha256 } from "../../src/lib/util.js";
import type { Dispatch, Evidence, OutboxItem } from "../../src/domain/types.js";

const SECRET = "y".repeat(40);
let h: Harness;
let s: Seed;
const drain = async (n = 3) => {
  for (let i = 0; i < n; i++) await runOutboxOnce(h.deps, 50);
};
const DAY = 86_400_000;

beforeEach(async () => {
  h = harness();
  s = await seed(h);
});

async function sendLrar(options: { arScan?: boolean } = {}): Promise<Dispatch> {
  const agent = h.as("agent", ["assistante"]);
  let d = await createDispatch(agent, {
    legalEntityId: LE_A, centerId: null, sourceType: "organization_file", sourceId: null, subject: { type: "organization", id: s.orgId },
    recipient: { organizationId: s.orgId }, purpose: "legal", templateVersionId: s.legalVersionId, postageClass: "lrar", options, idempotencyKey: idem(),
  });
  d = await previewDispatch(agent, d.id);
  d = await requestApproval(agent, d.id);
  d = await approveDispatch(h.as("manager", ["manager"]), d.id);
  d = await approveDispatch(h.as("director", ["direction"]), d.id);
  await drain(1);
  return getDispatch(h.as("director", ["direction"]), d.id);
}

describe("Recommandé avec AR — chaîne de preuves", () => {
  it("AR dématérialisé activé par défaut ; AR papier signalé", async () => {
    const d = await sendLrar();
    expect(d.optionsJson.arScan).toBe(true);
    expect((h.sp.calls.find((c) => c.url.endsWith("/previsualiser"))!.body as Record<string, unknown>).ar_scan).toBe(true);
    const paper = await sendLrar({ arScan: false });
    const audit = await h.root.find<{ action: string; metadataRedacted: { warnings?: string[] } }>("postal_audit_logs", { objectId: paper.id, action: "dispatch.created" });
    expect(audit[0]!.metadataRedacted.warnings?.join(" ")).toMatch(/AR papier/);
  });

  it("dépôt, contenu final, distribution, AR scanné J+10 et webhooks : tout est archivé et haché", async () => {
    const d = await sendLrar();
    expect(d.status).toBe("SUBMITTED");

    // Avant la prise en charge La Poste : aucune demande de preuve de dépôt.
    h.clock.advance(3 * 3_600_000);
    await drain(2);
    expect(h.sp.calls.filter((c) => c.url.endsWith("/preuve_depot")).length).toBe(0);

    // Production + dépôt, signalés par webhook.
    h.sp.advance(d.providerUid!, "imprime");
    h.sp.advance(d.providerUid!, "depose");
    const wh = JSON.stringify({ uid: d.providerUid, code_statut: "pris_en_charge" });
    expect((await ingestWebhook(h.deps, "servicepostal", s.spWebhookToken, wh)).result).toBe("accepted");
    await drain(3);
    let ev = await h.root.find<Evidence>("postal_evidence", { dispatchId: d.id });
    expect(ev.map((e) => e.kind).sort()).toEqual(["deposit_proof", "final_document"]);

    // Distribution
    h.sp.advance(d.providerUid!, "distribue");
    await ingestWebhook(h.deps, "servicepostal", s.spWebhookToken, JSON.stringify({ uid: d.providerUid, code_statut: "distribue_destinataire" }));
    await drain(2);
    expect((await getDispatch(h.as("director", ["direction"]), d.id)).status).toBe("DELIVERED");

    // L'AR scanné arrive 10 jours plus tard : le suivi quotidien le récupère.
    for (let day = 1; day <= 12; day++) {
      if (day === 10) h.sp.advance(d.providerUid!, "ar");
      h.clock.advance(DAY);
      await drain(2);
    }
    ev = await h.root.find<Evidence>("postal_evidence", { dispatchId: d.id });
    expect(ev.map((e) => e.kind).sort()).toEqual(["deposit_proof", "final_document", "scanned_ar", "tracking"]);
    const dead = await h.root.find<OutboxItem>("postal_outbox", { dispatchId: d.id, status: { in: ["dead", "human_task"] } });
    expect(dead).toHaveLength(0);

    // Dossier de preuves via l'API
    const app = createApi({ deps: h.deps, auth: hs256Authenticator(SECRET, { issuer: "saas", audience: "postal" }) });
    const tok = signHs256(SECRET, { sub: "auditor", tid: T, ent: [{ id: LE_A, roles: ["audit"] }], iss: "saas", aud: "postal", exp: Math.floor(Date.now() / 1000) + 600, mfa: true });
    const get = (path: string) => app.request(path, { headers: { authorization: `Bearer ${tok}`, "x-legal-entity-id": LE_A } });
    const bundle: any = await (await get(`/api/postal/dispatches/${d.id}/evidence-bundle`)).json();
    expect(bundle.data.evidence_missing).toEqual([]);
    expect(bundle.data.tracking_number).toBe("1A00000000001");
    expect(bundle.data.approved_document.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.data.approvals.map((a: { step: string }) => a.step)).toEqual(["review", "final_legal"]);
    expect(bundle.data.webhooks).toHaveLength(2);
    // Chaque preuve téléchargée correspond à son empreinte.
    for (const e of bundle.data.evidence) {
      const res = await get(e.download);
      expect(res.status).toBe(200);
      expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(e.sha256);
    }
    const w = await get(bundle.data.webhooks[0].download);
    expect(sha256(new Uint8Array(await w.arrayBuffer()))).toBe(bundle.data.webhooks[0].payload_sha256);
    const tracking = ev.find((e) => e.kind === "tracking")!;
    const tr: any = await (await get(`/api/postal/dispatches/${d.id}/evidence/${tracking.id}`)).json();
    expect(tr.response.numero_suivi_laposte).toBe("1A00000000001");
    expect(tr.response.evenements.map((x: { code_statut: string }) => x.code_statut)).toContain("distribue_destinataire");
  });

  it("preuve de dépôt tardive : attente patiente, pas d'abandon en quelques heures", async () => {
    const d = await sendLrar();
    h.sp.advance(d.providerUid!, "imprime");
    h.sp.advance(d.providerUid!, "depose");
    h.sp.fail(/\/preuve_depot$/, { kind: "status", status: 404, body: { code: 404, message: "Indisponible" } }, { times: 6 });
    h.clock.advance(3 * 3_600_000);
    for (let i = 0; i < 12; i++) {
      await drain(1);
      h.clock.advance(DAY / 2);
    }
    await drain(2);
    expect(await h.root.find<OutboxItem>("postal_outbox", { dispatchId: d.id, status: { in: ["dead", "human_task"] } })).toHaveLength(0);
    const ev = await h.root.find<Evidence>("postal_evidence", { dispatchId: d.id, kind: "deposit_proof" });
    expect(ev).toHaveLength(1);
  });
});
