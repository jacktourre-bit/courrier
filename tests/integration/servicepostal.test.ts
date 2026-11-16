import { beforeEach, describe, expect, it } from "vitest";
import { harness, idem, seed, LE_A, type Harness, type Seed } from "../helpers.js";
import {
  approveDispatch,
  cancelDispatch,
  createDispatch,
  getDispatch,
  modifyDispatch,
  previewDispatch,
  requestApproval,
  exportDocument,
} from "../../src/services/dispatch-service.js";
import { runOutboxOnce } from "../../src/services/worker.js";
import { ingestWebhook } from "../../src/services/webhooks.js";
import { setBudget, addRecipientAddress, grantSensitiveAuthorization } from "../../src/services/admin.js";
import { storeAsset } from "../../src/services/context.js";
import type { Dispatch, Evidence, PostalEvent } from "../../src/domain/types.js";
import { tinyPdf } from "../fakes.js";

let h: Harness;
let s: Seed;
const agent = () => h.as("agent", ["assistante"]);
const manager = () => h.as("manager", ["manager"]);
const direction = () => h.as("director", ["direction"]);

async function drain(times = 3) {
  for (let i = 0; i < times; i++) await runOutboxOnce(h.deps, 50);
}

async function adminLetter(postage: "ecopli" | "lrar" = "ecopli", extra: Partial<Parameters<typeof createDispatch>[1]> = {}) {
  return createDispatch(agent(), {
    legalEntityId: LE_A, centerId: null, sourceType: "organization_file", sourceId: null,
    subject: { type: "organization", id: s.orgId }, recipient: { organizationId: s.orgId },
    purpose: postage === "lrar" ? "legal" : "administrative",
    templateVersionId: postage === "lrar" ? s.legalVersionId : s.formalVersionId,
    postageClass: postage, options: postage === "lrar" ? { arScan: true } : {}, idempotencyKey: idem(), ...extra,
  });
}

beforeEach(async () => {
  h = harness();
  s = await seed(h);
});

describe("Service Postal — parcours administratif", () => {
  it("prévisualise, chiffre, approuve (4 yeux) puis valide l'UID (test 7)", async () => {
    let d = await adminLetter();
    expect(d.status).toBe("READY_FOR_PREVIEW");
    expect(d.provider).toBe("servicepostal");
    d = await previewDispatch(agent(), d.id);
    expect(d.status).toBe("PREVIEWED");
    expect(d.providerUid).toMatch(/^l-/);
    expect(d.quoteHtCents).toBe(238);
    expect(d.quoteTtcCents).toBe(139 + Math.round(99 * 1.2));
    expect(d.previewAssetId).not.toBeNull();
    // La requête de prévisualisation respecte le contrat documenté.
    const call = h.sp.calls.find((c) => c.url.endsWith("/lettres/previsualiser"))!;
    expect(call.headers.apikey).toBe(h.sp.apiKey);
    const body = call.body as Record<string, any>;
    expect(body.type_affranchissement).toBe("ecopli");
    expect(body.adresse_destination.nom_societe).toBe("SCI Démo");
    expect(body.fichier.format).toBe("pdf");
    expect(body.reference).toMatch(/^CORR-/);
    expect(body.reference.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(body)).not.toContain(s.orgId);

    d = await requestApproval(agent(), d.id);
    expect(d.status).toBe("PENDING_APPROVAL");
    // Le créateur ne peut pas approuver.
    await expect(approveDispatch(h.as("agent", ["manager"]), d.id)).rejects.toThrow(/quatre yeux/);
    d = await approveDispatch(manager(), d.id);
    expect(d.status).toBe("APPROVED");
    expect(h.sp.letters.get(d.providerUid!)!.statut).toBe("previsualise");
    await drain(1);
    const after = await getDispatch(manager(), d.id);
    expect(after.status).toBe("SUBMITTED");
    const l = h.sp.letters.get(d.providerUid!)!;
    expect(l.statut).toBe("valide");
    expect(l.reference).toBe(d.reference);
    expect(l.validations).toBe(1);
  });

  it("LRAR non médicale avec annexe : double validation, preuve de dépôt, AR scanné, PDF final haché (tests 8, 9, 26)", async () => {
    const pdf = await tinyPdf("bail");
    const asset = await storeAsset(agent(), { tenantId: agent().scope.tenantId, legalEntityId: LE_A, bytes: pdf, mimeType: "application/pdf", sensitivity: "personal_non_health", kind: "attachment" });
    let d = await adminLetter("lrar", { attachments: [{ assetId: asset.id, filename: "bail.pdf", category: "contract", sensitivity: "personal_non_health" }] });
    d = await previewDispatch(agent(), d.id);
    const body = h.sp.calls.find((c) => c.url.endsWith("/previsualiser"))!.body as Record<string, any>;
    expect(body.fichier_annexes).toHaveLength(1);
    expect(body.ar_scan).toBe(true);
    d = await requestApproval(agent(), d.id);
    d = await approveDispatch(manager(), d.id); // relecture
    expect(d.status).toBe("PENDING_APPROVAL");
    await expect(approveDispatch(h.as("manager2", ["manager"]), d.id)).rejects.toThrow(/approve_legal/);
    await expect(approveDispatch(h.as("manager", ["direction"]), d.id)).rejects.toThrow(/quatre yeux/);
    d = await approveDispatch(direction(), d.id);
    expect(d.status).toBe("APPROVED");
    await drain(1);

    h.sp.advance(d.providerUid!, "imprime");
    h.sp.advance(d.providerUid!, "depose");
    h.sp.advance(d.providerUid!, "distribue");
    h.sp.advance(d.providerUid!, "ar");
    h.clock.advance(3 * 3_600_000);
    await drain(4);
    const final = await getDispatch(manager(), d.id);
    expect(final.status).toBe("DELIVERED");
    expect(final.trackingNumber).toBe("1A00000000001");
    const ev = await h.root.find<Evidence>("postal_evidence", { dispatchId: d.id });
    expect(ev.map((e) => e.kind).sort()).toEqual(["deposit_proof", "final_document", "scanned_ar"]);
    for (const e of ev) expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Piste d'audit : création, relecture, approbation finale, soumission.
    const audit = await h.root.find<{ action: string; actorId: string }>("postal_audit_logs", { objectId: d.id });
    const actions = audit.map((a) => `${a.action}:${a.actorId}`);
    expect(actions).toEqual(expect.arrayContaining(["dispatch.created:agent", "dispatch.approval_step.review:manager", "dispatch.approved:director", "dispatch.submitted:null"]));
  });

  it("toute modification invalide l'approbation (test 12)", async () => {
    let d = await adminLetter();
    d = await previewDispatch(agent(), d.id);
    d = await requestApproval(agent(), d.id);
    d = await modifyDispatch(agent(), d.id, { postageClass: "verte" });
    expect(d.status).toBe("READY_FOR_PREVIEW");
    expect(d.approvalHash).toBeNull();
    await expect(approveDispatch(manager(), d.id)).rejects.toThrow(/Approbation impossible/);
  });

  it("timeout après POST /valider : pas de double commande, rapprochement (test 15)", async () => {
    let d = await adminLetter();
    d = await previewDispatch(agent(), d.id);
    d = await requestApproval(agent(), d.id);
    d = await approveDispatch(manager(), d.id);
    h.sp.fail(/\/valider$/, { kind: "timeout_after_send" });
    await drain(1);
    let cur = await getDispatch(manager(), d.id);
    expect(cur.status).toBe("UNKNOWN_SUBMISSION_STATUS");
    h.clock.advance(10 * 60_000);
    await drain(2);
    cur = await getDispatch(manager(), d.id);
    expect(cur.status).toBe("SUBMITTED");
    expect(h.sp.letters.get(d.providerUid!)!.validations).toBe(1);
    expect(h.sp.calls.filter((c) => c.url.endsWith("/valider")).length).toBe(1);
  });

  it("refus réseau certain avant envoi : nouvelle tentative sans risque", async () => {
    let d = await adminLetter();
    d = await previewDispatch(agent(), d.id);
    d = await requestApproval(agent(), d.id);
    d = await approveDispatch(manager(), d.id);
    h.sp.fail(/\/valider$/, { kind: "refused" });
    await drain(1);
    expect((await getDispatch(manager(), d.id)).status).toBe("APPROVED");
    h.clock.advance(60_000);
    await drain(1);
    expect((await getDispatch(manager(), d.id)).status).toBe("SUBMITTED");
  });

  it("401 / 429 / 5xx : tâche humaine, Retry-After, aucune double commande (test 16)", async () => {
    let d = await adminLetter();
    d = await previewDispatch(agent(), d.id);
    d = await requestApproval(agent(), d.id);
    d = await approveDispatch(manager(), d.id);
    h.sp.fail(/\/valider$/, { kind: "status", status: 429, headers: { "retry-after": "120" } });
    await drain(1);
    expect((await getDispatch(manager(), d.id)).status).toBe("APPROVED");
    await drain(1); // pas encore dû
    expect(h.sp.calls.filter((c) => c.url.endsWith("/valider")).length).toBe(1);
    h.clock.advance(121_000);
    h.sp.fail(/\/valider$/, { kind: "status", status: 401, body: { code: 401, message: "API Key invalide" } });
    await drain(1);
    const cur = await getDispatch(manager(), d.id);
    expect(cur.status).toBe("FAILED_PROVIDER");
    expect(cur.incident).toMatch(/Clé API invalide/);
    const tasks = await h.root.find<{ kind: string }>("postal_human_tasks", { dispatchId: d.id, status: "open" });
    expect(tasks.map((t) => t.kind)).toContain("outbox_submit");
  });

  it("annulation dans la fenêtre puis refusée hors fenêtre (test 18)", async () => {
    const make = async () => {
      let d = await adminLetter();
      d = await previewDispatch(agent(), d.id);
      d = await requestApproval(agent(), d.id);
      d = await approveDispatch(manager(), d.id);
      await drain(1);
      return getDispatch(manager(), d.id);
    };
    const a = await make();
    await cancelDispatch(manager(), a.id, "erreur de destinataire");
    expect((await getDispatch(manager(), a.id)).status).toBe("CANCEL_REQUESTED");
    await drain(1);
    expect((await getDispatch(manager(), a.id)).status).toBe("CANCELLED");

    const b = await make();
    h.sp.advance(b.providerUid!, "imprime");
    await cancelDispatch(manager(), b.id, "trop tard");
    await drain(1);
    const cur = await getDispatch(manager(), b.id);
    expect(cur.status).toBe("SUBMITTED"); // jamais « annulé » sans confirmation
    expect(cur.incident).toMatch(/Annulation refusée/);
  });

  it("webhooks : doublon ignoré, payload forgé sans effet direct, jeton inconnu rejeté (tests 13, 20)", async () => {
    let d = await adminLetter();
    d = await previewDispatch(agent(), d.id);
    d = await requestApproval(agent(), d.id);
    d = await approveDispatch(manager(), d.id);
    await drain(1);
    const forged = JSON.stringify({ uid: d.providerUid, statut: "distribue_destinataire" });
    expect((await ingestWebhook(h.deps, "servicepostal", "x".repeat(43), forged)).httpStatus).toBe(404);
    const r1 = await ingestWebhook(h.deps, "servicepostal", s.spWebhookToken, forged);
    const r2 = await ingestWebhook(h.deps, "servicepostal", s.spWebhookToken, forged);
    expect(r1.result).toBe("accepted");
    expect(r2.result).toBe("duplicate");
    await drain(1);
    // Le prestataire indique « valide » : le statut « distribué » du payload n'a pas été cru.
    expect((await getDispatch(manager(), d.id)).status).toBe("SUBMITTED");
    const events = await h.root.find<PostalEvent>("postal_events", { dispatchId: d.id, provider: "servicepostal" });
    const ids = events.map((e) => e.providerEventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("budget dépassé : approbation exceptionnelle motivée requise", async () => {
    await setBudget(h.as("admin", ["administrateur"]), { legalEntityId: LE_A, centerId: null, campaignId: null, month: "2026-11", limitCents: 100, alertThresholds: [0.5, 0.8, 1] });
    let d = await adminLetter();
    d = await previewDispatch(agent(), d.id);
    d = await requestApproval(agent(), d.id);
    await expect(approveDispatch(manager(), d.id)).rejects.toThrow(/Budget dépassé/);
    await expect(approveDispatch(manager(), d.id, { budgetOverride: true, reason: "urgence" })).rejects.toThrow(/budget.override/);
    d = await approveDispatch(direction(), d.id, { budgetOverride: true, reason: "urgence contentieux" });
    expect(d.status).toBe("APPROVED");
  });

  it("courrier patient -> CPAM : classé santé, bloqué avant tout appel prestataire, export sécurisé possible (test 22)", async () => {
    const before = h.sp.calls.length;
    await expect(
      createDispatch(agent(), {
        legalEntityId: LE_A, centerId: null, sourceType: "patient_file", sourceId: null,
        subject: { type: "patient", id: s.patientId }, recipient: { organizationId: s.publicOrgId },
        purpose: "administrative", templateVersionId: s.formalVersionId, postageClass: "lrar", idempotencyKey: idem(),
      }),
    ).rejects.toMatchObject({ code: "SENSITIVE_BLOCKED" });
    expect(h.sp.calls.length).toBe(before);
  });

  it("flag sensible activé : sans autorisation documentée toujours bloqué ; avec, étape d'approbation dédiée", async () => {
    h.deps.config.flags.SENSITIVE_POSTAL_ALLOWED = true;
    const input = {
      legalEntityId: LE_A, centerId: null, sourceType: "patient_file" as const, sourceId: null,
      subject: { type: "patient" as const, id: s.patientId }, recipient: { organizationId: s.publicOrgId },
      purpose: "administrative" as const, templateVersionId: s.formalVersionId, postageClass: "ecopli" as const,
    };
    await expect(createDispatch(agent(), { ...input, idempotencyKey: idem() })).rejects.toMatchObject({ code: "SENSITIVE_BLOCKED" });
    await grantSensitiveAuthorization(h.as("dpo", [], LE_A, ["postal.sensitive.authorize"]), { legalEntityId: LE_A, provider: "servicepostal", templateId: s.formalTemplateId, documentRef: "DPA-SP-2026-01 + analyse HDS", expiresAt: null });
    let d = await createDispatch(agent(), { ...input, idempotencyKey: idem() });
    expect(d.sensitivity).toBe("health");
    d = await previewDispatch(agent(), d.id);
    d = await requestApproval(agent(), d.id);
    d = await approveDispatch(manager(), d.id);
    expect(d.status).toBe("PENDING_APPROVAL");
    await expect(approveDispatch(direction(), d.id)).rejects.toThrow(/approve_sensitive/);
    d = await approveDispatch(h.as("dpo-approver", [], LE_A, ["postal.read", "postal.approve_sensitive"]), d.id);
    expect(d.status).toBe("APPROVED");
    const exp = await exportDocument(direction(), d.id);
    expect(Buffer.from(exp.bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });

  it("organisme sans adresse vérifiée bloqué (test 11) et adresse modifiée après approbation sans effet (§5.1)", async () => {
    await expect(
      createDispatch(agent(), {
        legalEntityId: LE_A, centerId: null, sourceType: "patient_file", sourceId: null, subject: { type: "patient", id: s.patientId },
        recipient: { addressId: (await addRecipientAddress(h.as("admin", ["administrateur"]), { legalEntityId: LE_A, subjectType: "patient", subjectId: s.patientId, address: { lastName: "Martin", line1: "1 rue", postalCode: "123", city: "X", country: "FR" } })).id },
        purpose: "administrative", templateVersionId: s.formalVersionId, postageClass: "ecopli", idempotencyKey: idem(),
      }),
    ).rejects.toThrow(/Code postal invalide/);
    const { upsertOrganization } = await import("../../src/services/admin.js");
    const unverified = await upsertOrganization(h.as("admin", ["manager"]), {
      legalEntityId: LE_A, centerId: null, category: "fournisseur", name: "Fournisseur X", branch: null, service: null,
      addressJson: { company: "Fournisseur X", line1: "3 rue Y", postalCode: "33000", city: "Bordeaux", country: "FR" },
      channelPolicy: { recommendedChannel: "courrier", postalAccepted: true }, verifiedAt: null, source: null, active: true,
    });
    await expect(adminLetter("ecopli", { subject: { type: "organization", id: unverified.id }, recipient: { organizationId: unverified.id } })).rejects.toThrow(/non vérifiée/);
    let d = await adminLetter();
    const snap = d.recipientSnapshotJson;
    d = await previewDispatch(agent(), d.id);
    expect(d.recipientSnapshotJson).toEqual(snap);
  });

  it("isolement : un utilisateur de la société B ne voit pas un courrier de A (test 21)", async () => {
    const d = await adminLetter();
    await expect(getDispatch(h.as("other", ["direction"], "00000000-0000-4000-8000-0000000000b1"), d.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("idempotence de création : même clé => même envoi", async () => {
    const key = idem();
    const a = await adminLetter("ecopli", { idempotencyKey: key });
    const b = await adminLetter("ecopli", { idempotencyKey: key });
    expect(b.id).toBe(a.id);
    expect((await h.root.find<Dispatch>("postal_dispatches", {})).length).toBe(1);
  });
  it("sandbox/production et clés séparées par société (test 17)", async () => {
    const { createConnection } = await import("../../src/services/admin.js");
    await expect(createConnection(h.as("admin", ["administrateur"]), { legalEntityId: LE_A, provider: "servicepostal", environment: "production", credentialsSecretRef: "env:SP_PROD" })).rejects.toThrow(/production interdite/);
    await expect(createConnection(h.as("admin", ["administrateur"]), { legalEntityId: LE_A, provider: "servicepostal", environment: "sandbox", credentialsSecretRef: "sk_live_123" })).rejects.toThrow(/Référence de secret/);
    // La société B n'a pas de connexion : aucun envoi possible avec la clé de A.
    const { resolveConnection } = await import("../../src/services/context.js");
    await expect(resolveConnection(h.as("x", ["direction"], "00000000-0000-4000-8000-0000000000b1"), "00000000-0000-4000-8000-0000000000b1", "servicepostal")).rejects.toThrow(/Aucune connexion/);
    expect(h.sp.calls.every((c) => c.url.startsWith("https://sandbox-api.servicepostal.com") || c.url.startsWith("https://cdn."))).toBe(true);
  });

  it("import de preuve repris après coupure réseau (test 19)", async () => {
    let d = await adminLetter("lrar");
    d = await previewDispatch(agent(), d.id);
    d = await requestApproval(agent(), d.id);
    d = await approveDispatch(manager(), d.id);
    d = await approveDispatch(direction(), d.id);
    await drain(1);
    h.sp.advance(d.providerUid!, "imprime");
    h.sp.advance(d.providerUid!, "depose");
    h.sp.fail(/\/contenu$/, { kind: "refused" });
    h.clock.advance(3 * 3_600_000);
    await drain(2);
    let ev = await h.root.find<Evidence>("postal_evidence", { dispatchId: d.id });
    expect(ev.map((e) => e.kind)).not.toContain("final_document");
    h.clock.advance(2 * 3_600_000);
    await drain(2);
    ev = await h.root.find<Evidence>("postal_evidence", { dispatchId: d.id });
    expect(ev.map((e) => e.kind).sort()).toEqual(["deposit_proof", "final_document"]);
  });
});
