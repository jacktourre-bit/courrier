import { beforeEach, describe, expect, it } from "vitest";
import { harness, idem, seed, LE_A, T, type Harness, type Seed } from "../helpers.js";
import { tinyPdf } from "../fakes.js";
import { addTemplateVersion, approveTemplateVersion, createTemplate } from "../../src/services/templates.js";
import { grantSensitiveAuthorization, revokeSensitiveAuthorization, upsertOrganization, upsertSenderProfile } from "../../src/services/admin.js";
import { approveDispatch, cancelDispatch, createDispatch, getDispatch, previewDispatch, requestApproval } from "../../src/services/dispatch-service.js";
import { readAsset, storeAsset } from "../../src/services/context.js";
import { runOutboxOnce } from "../../src/services/worker.js";
import { runRetentionPurge, setRetentionPolicy } from "../../src/services/retention.js";
import { isValidNir } from "../../src/domain/merge-fields.js";
import { createApi } from "../../src/api/app.js";
import { hs256Authenticator, signHs256 } from "../../src/api/auth.js";
import type { Dispatch } from "../../src/domain/types.js";

/** Recette dédiée P4 (§17) : courriers comportant des données de santé vers CPAM / MDPH. Données fictives. */
let h: Harness;
let s: Seed;
let cpamTemplateId: string;
let cpamVersionId: string;
let authId: string;

const nirWithKey = (body13: string) => `${body13}${String(97 - Number(BigInt(body13) % 97n)).padStart(2, "0")}`;
const NIR = nirWithKey("1850578006084");
const agent = () => h.as("agent", ["assistante"], LE_A, ["postal.sensitive.enter", "postal.sensitive.attach"]);
const manager = () => h.as("manager", ["manager"]);
const dpo = () => h.as("dpo", [], LE_A, ["postal.read", "postal.sensitive.authorize", "postal.approve_sensitive", "postal.sensitive.read", "postal.retention.manage"]);

async function audiogram(category: "audiogram" | "prescription" = "audiogram") {
  const a = await storeAsset(agent(), { tenantId: T, legalEntityId: LE_A, bytes: await tinyPdf("audiogramme fictif"), mimeType: "application/pdf", sensitivity: "health", kind: "attachment" });
  return { assetId: a.id, filename: `${category}.pdf`, category, sensitivity: "health" as const, justification: "Pièce exigée par la CPAM pour l'accord préalable" };
}

const cpamInput = (extra: Partial<Parameters<typeof createDispatch>[1]> = {}) => ({
  legalEntityId: LE_A, centerId: null, sourceType: "patient_file" as const, sourceId: null,
  subject: { type: "patient" as const, id: s.patientId }, recipient: { organizationId: s.publicOrgId },
  purpose: "administrative" as const, templateVersionId: cpamVersionId, postageClass: "lrar" as const, idempotencyKey: idem(),
  sensitiveValues: { "patient.nir": NIR },
  ...extra,
});

beforeEach(async () => {
  h = harness({ SENSITIVE_POSTAL_ALLOWED: true });
  s = await seed(h);
  const admin = h.as("admin", ["manager"]);
  const t = await createTemplate(admin, { legalEntityId: LE_A, type: "formal", provider: "servicepostal", purpose: "administrative", title: "Demande d'accord préalable CPAM" });
  const v = await addTemplateVersion(admin, t.id, {
    allowedMergeFields: ["patient.nom", "patient.prenom", "patient.nir", "destinataire.societe"],
    content: { subject: "Demande d'accord préalable", references: ["Assuré : {{patient.prenom}} {{patient.nom}} — NIR {{patient.nir}}"], body: "Madame, Monsieur,\n\nVeuillez trouver ci-joint la demande pour {{destinataire.societe}}.", signatureName: "Le centre", annexesList: ["Audiogramme"] },
    declaredSensitivity: "health",
  });
  await approveTemplateVersion(h.as("director", ["direction"]), v.id);
  cpamTemplateId = t.id;
  cpamVersionId = v.id;
  const a = await grantSensitiveAuthorization(dpo(), {
    legalEntityId: LE_A, provider: "servicepostal", templateId: t.id, documentRef: "AIPD-CPAM-2026", dpaRef: "DPA-SP-2026-01", qualification: "hds_certified",
    certificateRef: "CERT-HDS-FICTIF", certificateScope: "activités 1 à 6 (fictif)", certificateExpiresAt: "2027-06-30T00:00:00Z",
    allowedAttachmentCategoriesJson: ["audiogram"], allowedRecipientCategoriesJson: ["cpam"], expiresAt: null,
  });
  authId = a.id;
});

describe("P4 — courriers de santé", () => {
  it("NIR : clé de contrôle vérifiée", () => {
    expect(isValidNir(NIR)).toBe(true);
    expect(isValidNir(NIR.slice(0, 13) + "00")).toBe(false);
    expect(isValidNir(nirWithKey("2690299341732").replace(/^(\d{5})99/, "$12A").slice(0, 13) + "00")).toBe(false);
  });

  it("parcours complet : saisie habilitée, pièce justifiée, double approbation dont sensible, envoi ; NIR jamais en clair en base ni dans les logs", async () => {
    let d = await createDispatch(agent(), cpamInput({ attachments: [await audiogram()] }));
    expect(d.sensitivity).toBe("health");
    expect(JSON.stringify(d.mergeValuesJson)).not.toContain(NIR);
    d = await previewDispatch(agent(), d.id);
    const body = h.sp.calls.find((c) => c.url.endsWith("/previsualiser"))!.body as Record<string, any>;
    expect(body.fichier_annexes).toHaveLength(1);
    expect(body.adresse_expedition.nom_societe).toBe("Centre Démo");
    expect(body.reference).toMatch(/^CORR-/);
    d = await requestApproval(agent(), d.id);
    d = await approveDispatch(manager(), d.id); // relecture
    d = await approveDispatch(h.as("director", ["direction"]), d.id); // approbation juridique LRAR
    expect(d.status).toBe("PENDING_APPROVAL");
    d = await approveDispatch(dpo(), d.id); // étape sensible
    expect(d.status).toBe("APPROVED");
    await runOutboxOnce(h.deps);
    expect((await getDispatch(manager(), d.id)).status).toBe("SUBMITTED");
    // Le NIR n'existe qu'à l'intérieur d'un actif chiffré.
    const rows = JSON.stringify(await h.root.find("postal_dispatches", {})) + JSON.stringify(await h.root.find("postal_audit_logs", {})) + JSON.stringify(await h.root.find("postal_events", {}));
    expect(rows).not.toContain(NIR);
    expect(h.logs.join("\n")).not.toContain(NIR);
    const vals = await readAsset(dpo(), (d.optionsJson as { sensitiveValuesAssetId: string }).sensitiveValuesAssetId);
    expect(JSON.parse(new TextDecoder().decode(vals.bytes))["patient.nir"]).toBe(NIR);
    const att = await h.root.find<{ justification: string; addedBy: string }>("postal_attachments", { dispatchId: d.id });
    expect(att[0]!.justification).toMatch(/accord préalable/);
    expect(att[0]!.addedBy).toBe("agent");
  });

  it("saisie sensible : NIR invalide, NIR manquant, utilisateur non habilité", async () => {
    await expect(createDispatch(agent(), cpamInput({ sensitiveValues: { "patient.nir": NIR.slice(0, 13) + "00" } }))).rejects.toThrow(/NIR invalide/);
    await expect(createDispatch(agent(), cpamInput({ sensitiveValues: {} }))).rejects.toThrow(/Saisie requise/);
    await expect(createDispatch(h.as("agent2", ["assistante"]), cpamInput())).rejects.toThrow(/sensitive.enter/);
  });

  it("pièces : justification obligatoire, habilitation requise, catégorie hors périmètre refusée", async () => {
    await expect(createDispatch(agent(), cpamInput({ attachments: [{ ...(await audiogram()), justification: "" }] }))).rejects.toThrow(/Justification requise/);
    await expect(createDispatch(h.as("agent3", ["assistante"], LE_A, ["postal.sensitive.enter"]), cpamInput({ attachments: [await audiogram()] }))).rejects.toThrow(/sensitive.attach/);
    await expect(createDispatch(agent(), cpamInput({ attachments: [await audiogram("prescription")] }))).rejects.toMatchObject({ code: "SENSITIVE_BLOCKED" });
  });

  it("organisme hors périmètre (MDPH non autorisée) et enveloppe révélant une activité de santé : bloqués", async () => {
    const mdph = await upsertOrganization(h.as("admin", ["manager"]), {
      legalEntityId: null, centerId: null, category: "mdph", name: "MDPH Démo", branch: null, service: null,
      addressJson: { company: "MDPH Démo", line1: "10 rue X", postalCode: "69003", city: "Lyon", country: "FR" },
      channelPolicy: { recommendedChannel: "postal", postalAccepted: true }, verifiedAt: "2026-10-01T00:00:00Z", source: "site", active: true,
    });
    await expect(createDispatch(agent(), cpamInput({ recipient: { organizationId: mdph.id } }))).rejects.toThrow(/hors du périmètre/);
    const sender = (await h.root.find<{ id: string }>("postal_sender_profiles", {}))[0]!;
    await upsertSenderProfile(h.as("admin", ["administrateur"]), { id: sender.id, legalEntityId: LE_A, centerId: null, businessName: "Audition Démo SAS", envelopeDisplayName: "Audition Démo", postalAddressJson: { line1: "1 place de la Gare", postalCode: "69002", city: "Lyon", country: "FR" }, contact: null, signatureAssetId: null, defaultProvider: null, active: true });
    await expect(createDispatch(agent(), cpamInput())).rejects.toThrow(/enveloppe/);
  });

  it("certificat HDS expiré ou autorisation révoquée : envoi bloqué au dernier contrôle, avant tout appel", async () => {
    let d = await createDispatch(agent(), cpamInput({ postageClass: "ecopli" }));
    d = await previewDispatch(agent(), d.id);
    d = await requestApproval(agent(), d.id);
    d = await approveDispatch(manager(), d.id);
    d = await approveDispatch(dpo(), d.id);
    h.clock.set("2027-07-01T09:00:00Z");
    await runOutboxOnce(h.deps);
    const cur = await getDispatch(manager(), d.id);
    expect(cur.status).toBe("FAILED_VALIDATION");
    expect(cur.incident).toMatch(/Certificat HDS/);
    expect(h.sp.calls.filter((c) => c.url.endsWith("/valider"))).toHaveLength(0);

    h.clock.set("2026-11-16T09:00:00Z");
    await revokeSensitiveAuthorization(dpo(), authId, "fin du contrat");
    await expect(createDispatch(agent(), cpamInput())).rejects.toThrow(/révoquée/);
  });

  it("autorisation : DPA et certificat exigés ; jamais vers Manuscry", async () => {
    const base = { legalEntityId: LE_A, provider: "servicepostal" as const, templateId: cpamTemplateId, documentRef: "AIPD", dpaRef: "DPA-1", qualification: "hds_certified" as const, certificateRef: null, certificateScope: null, certificateExpiresAt: null, allowedAttachmentCategoriesJson: [], allowedRecipientCategoriesJson: ["cpam"], expiresAt: null };
    await expect(grantSensitiveAuthorization(dpo(), base)).rejects.toThrow(/Certificat HDS/);
    await expect(grantSensitiveAuthorization(dpo(), { ...base, dpaRef: "" })).rejects.toThrow(/DPA/);
    await expect(grantSensitiveAuthorization(dpo(), { ...base, provider: "manuscry" })).rejects.toThrow(/Manuscry/);
    await expect(grantSensitiveAuthorization(h.as("director", ["direction"]), { ...base, qualification: "hds_out_of_scope_justified" })).rejects.toThrow(/sensitive.authorize/);
  });

  it("lecture des contenus sensibles réservée à la permission nominative (API)", async () => {
    let d = await createDispatch(agent(), cpamInput());
    d = await previewDispatch(agent(), d.id);
    const SECRET = "z".repeat(40);
    const app = createApi({ deps: h.deps, auth: hs256Authenticator(SECRET, { issuer: "saas", audience: "postal" }) });
    const tok = (perms: string[]) => signHs256(SECRET, { sub: "u", tid: T, ent: [{ id: LE_A, roles: ["direction"], perms }], iss: "saas", aud: "postal", exp: Math.floor(Date.now() / 1000) + 600, mfa: true });
    const get = (t: string, p: string) => app.request(`/api/postal/dispatches/${d.id}${p}`, { headers: { authorization: `Bearer ${t}`, "x-legal-entity-id": LE_A } });
    for (const p of ["/document", "/document?which=preview", "/export", "/evidence-bundle"]) expect((await get(tok([]), p)).status).toBe(403);
    expect((await get(tok(["postal.sensitive.read"]), "/document")).status).toBe(200);
    expect((await get(tok(["postal.sensitive.read"]), "/evidence-bundle")).status).toBe(200);
  });

  it("purge de conservation : contenu supprimé, empreinte conservée ; envoi actif jamais purgé", async () => {
    const live = await createDispatch(agent(), cpamInput());
    const done = await createDispatch(agent(), cpamInput());
    await cancelDispatch(manager(), done.id, "doublon");
    await setRetentionPolicy(dpo(), { legalEntityId: LE_A, assetKind: "generated_document", retainDays: 30, legalBasis: "Décision DPO 2026-11 (fictive)" });
    await setRetentionPolicy(dpo(), { legalEntityId: LE_A, assetKind: "sensitive_values", retainDays: 30, legalBasis: "Décision DPO 2026-11 (fictive)" });
    h.clock.advance(31 * 86_400_000);
    const r = await runRetentionPurge(h.deps);
    expect(r.purged).toBe(2);
    expect(r.skippedInUse).toBe(2);
    const doneRow = (await h.root.one<Dispatch>("postal_dispatches", { id: done.id }))!;
    await expect(readAsset(dpo(), doneRow.documentAssetId!)).rejects.toThrow(/purgée/);
    const asset = await h.root.one<{ sha256: string; purgedAt: string }>("postal_assets", { id: doneRow.documentAssetId! });
    expect(asset!.sha256).toBe(doneRow.documentHash);
    expect(asset!.purgedAt).not.toBeNull();
    const liveRow = (await h.root.one<Dispatch>("postal_dispatches", { id: live.id }))!;
    expect((await readAsset(dpo(), liveRow.documentAssetId!)).bytes.length).toBeGreaterThan(0);
    await expect(setRetentionPolicy(manager(), { legalEntityId: LE_A, assetKind: "x_kind", retainDays: 1, legalBasis: "xxx" })).rejects.toThrow(/retention.manage/);
  });
});
