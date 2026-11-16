import { beforeEach, describe, expect, it } from "vitest";
import { harness, idem, seed, LE_A, CENTER_A, type Harness, type Seed } from "../helpers.js";
import { approveCampaign, createCampaign, runBirthdayScheduler } from "../../src/services/campaigns.js";
import { runOutboxOnce } from "../../src/services/worker.js";
import { ingestWebhook } from "../../src/services/webhooks.js";
import { setPreference } from "../../src/services/preferences.js";
import { addRecipientAddress, upsertSubject } from "../../src/services/admin.js";
import { createDispatch, getDispatch, previewDispatch, requestApproval, approveDispatch } from "../../src/services/dispatch-service.js";
import { addTemplateVersion, createTemplate } from "../../src/services/templates.js";
import type { CampaignRecipient, Dispatch } from "../../src/domain/types.js";
import { FR_ADDRESS } from "../helpers.js";

let h: Harness;
let s: Seed;
const manager = () => h.as("manager", ["manager"]);
const direction = () => h.as("director", ["direction"]);
const drain = async (n = 3) => {
  for (let i = 0; i < n; i++) await runOutboxOnce(h.deps, 50);
};

async function birthdayCampaign(rules: Record<string, unknown> = { recurrenceOwner: "saas" }) {
  const c = await createCampaign(manager(), { legalEntityId: LE_A, centerId: null, type: "birthday", templateVersionId: s.bdayVersionId, purpose: "relationship", rules: rules as never });
  return approveCampaign(direction(), c.id);
}

async function addPatient(p: { birthDate: string; firstName?: string; deceased?: boolean; optIn?: boolean; country?: string }) {
  const admin = h.as("admin", ["administrateur", "manager"]);
  const sub = await upsertSubject(admin, {
    legalEntityId: LE_A, centerId: CENTER_A, type: "patient", civility: "M.", firstName: p.firstName ?? "Paul", lastName: "Durand", company: null,
    birthDate: p.birthDate, birthDateReliable: true, deceased: !!p.deceased, archived: false, litigation: false, hasLegalRepresentative: false, publicReference: null,
  });
  const address = p.country === "BE" ? { lastName: "Durand", line1: "1 rue Neuve", postalCode: "1000", city: "Bruxelles", country: "BE" } : { ...FR_ADDRESS, firstName: "Paul", lastName: "Durand" };
  await addRecipientAddress(admin, { legalEntityId: LE_A, subjectType: "patient", subjectId: sub.id, address, verifiedAt: "2026-09-01T00:00:00Z" });
  if (p.optIn !== false) await setPreference(admin, { legalEntityId: LE_A, subjectType: "patient", subjectId: sub.id, purpose: "birthday", allowed: true, source: "test" });
  return sub;
}

beforeEach(async () => {
  h = harness();
  s = await seed(h);
});

describe("Manuscry — anniversaires", () => {
  it("un seul envoi annuel, champs dynamiques, aucune donnée médicale ni année de naissance (tests 1, 5, 27)", async () => {
    await birthdayCampaign();
    const r1 = await runBirthdayScheduler(h.deps);
    expect(r1.dispatched).toBe(1);
    await drain(1);
    // Relance du même jour et du lendemain : aucun doublon.
    await runBirthdayScheduler(h.deps);
    h.clock.advance(86_400_000);
    await runBirthdayScheduler(h.deps);
    await drain(2);
    expect(h.ms.contacts).toHaveLength(1);
    const body = h.ms.contacts[0]!.body;
    expect(body).toMatchObject({ address_line1: "Mme Alice Martin", address_line2: "12 rue des Lilas", address_zip: "75011", address_city: "PARIS", address_country: "FR", prenom: "Alice", birthday_date: "2026-12-01" });
    expect(body.identifier).toMatch(/^CORR-/);
    expect(body.ai_context).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/1960|audit|appareil|DOS-0001/);
    expect(JSON.stringify(body)).not.toContain(s.patientId);
    const call = h.ms.calls.find((c) => c.method === "POST")!;
    expect(call.headers.authorization).toBe(`Bearer ${h.ms.apiKey}`);
    expect(call.url).not.toContain("api_key");
    const d = (await h.root.find<Dispatch>("postal_dispatches", { provider: "manuscry" }))[0]!;
    expect(d.status).toBe("SUBMITTED");
    expect(d.eventKey).toBe("birthday:2026");
  });

  it("opposition, absence d'accord, mineur et décès exclus (tests 2, 3)", async () => {
    await birthdayCampaign();
    await setPreference(h.as("admin", ["manager"]), { legalEntityId: LE_A, subjectType: "patient", subjectId: s.patientId, purpose: "birthday", allowed: false, source: "appel patient" });
    await addPatient({ birthDate: "2012-12-02", firstName: "Mineur" });
    await addPatient({ birthDate: "1950-12-03", firstName: "Defunt", deceased: true });
    await addPatient({ birthDate: "1970-12-04", firstName: "SansAccord", optIn: false });
    const r = await runBirthdayScheduler(h.deps);
    expect(r.dispatched).toBe(0);
    expect(r.skipped).toMatchObject({ opposition_specific: 1, subject_minor: 1, optin_missing: 1 });
    await drain(1);
    expect(h.ms.contacts).toHaveLength(0);
  });

  it("anniversaire trop proche ou passé : jamais d'envoi immédiat ; international = 10 jours (test 4)", async () => {
    await birthdayCampaign();
    await addPatient({ birthDate: "1980-11-20" }); // J+4 : délai dépassé
    await addPatient({ birthDate: "1980-11-10" }); // passé
    await addPatient({ birthDate: "1980-11-26", country: "BE" }); // J+10 < 10+2
    const r = await runBirthdayScheduler(h.deps);
    const recs = await h.root.find<CampaignRecipient>("postal_campaign_recipients", {});
    expect(recs.filter((x) => x.reason === "late")).toHaveLength(1);
    expect(r.dispatched).toBe(1); // seul le patient de la graine (01/12)
  });

  it("29 février : célébré le 28 en année non bissextile", async () => {
    h.clock.set("2027-02-10T09:00:00Z");
    await birthdayCampaign();
    await addPatient({ birthDate: "2000-02-29", firstName: "Leap" });
    const r = await runBirthdayScheduler(h.deps);
    expect(r.dispatched).toBe(1);
    await drain(1);
    expect(h.ms.contacts.find((c) => c.body.prenom === "Leap")!.body.birthday_date).toBe("2027-02-28");
  });

  it("changement d'adresse après approbation : l'instantané approuvé est conservé", async () => {
    await birthdayCampaign();
    await runBirthdayScheduler(h.deps);
    await addRecipientAddress(h.as("admin", ["administrateur"]), { legalEntityId: LE_A, subjectType: "patient", subjectId: s.patientId, address: { ...FR_ADDRESS, line1: "99 boulevard Nouveau" }, verifiedAt: "2026-11-16T00:00:00Z" });
    await drain(1);
    expect(h.ms.contacts[0]!.body.address_line2).toBe("12 rue des Lilas");
  });

  it("récurrence non tranchée : activation refusée (§5.2.8)", async () => {
    const c = await createCampaign(manager(), { legalEntityId: LE_A, centerId: null, type: "birthday", templateVersionId: s.bdayVersionId, purpose: "relationship" });
    await expect(approveCampaign(direction(), c.id)).rejects.toThrow(/récurrence/);
  });

  it("opposition après transmission : blocage chez Manuscry (§5.2.9)", async () => {
    await birthdayCampaign();
    await runBirthdayScheduler(h.deps);
    await drain(1);
    const d = (await h.root.find<Dispatch>("postal_dispatches", { provider: "manuscry" }))[0]!;
    h.ms.generate(d.reference, "generating");
    await setPreference(h.as("admin", ["manager"]), { legalEntityId: LE_A, subjectType: "patient", subjectId: s.patientId, purpose: "birthday", allowed: false, source: "courrier patient" });
    await drain(1);
    expect(h.ms.blocked).toHaveLength(1);
  });

  it("campagne suspendue chez Manuscry (403) : échec qualifié, tâche humaine, pas de bascule vers Service Postal (test 16)", async () => {
    await birthdayCampaign();
    h.ms.campaigns["cmp-bday"]!.status = "paused";
    await runBirthdayScheduler(h.deps);
    await drain(1);
    const d = (await h.root.find<Dispatch>("postal_dispatches", { provider: "manuscry" }))[0]!;
    expect(d.status).toBe("FAILED_PROVIDER");
    expect(d.incident).toMatch(/Campagne/);
    expect(h.sp.calls.filter((c) => c.url.includes("/lettres")).length).toBe(0);
  });
});

describe("Manuscry — courrier ponctuel et suivi", () => {
  async function thanks() {
    const agent = h.as("agent", ["audioprothesiste"]);
    let d = await createDispatch(agent, {
      legalEntityId: LE_A, centerId: CENTER_A, sourceType: "patient_file", sourceId: null, subject: { type: "patient", id: s.patientId },
      recipient: { addressId: s.addressId }, purpose: "relationship", templateVersionId: s.manualVersionId, postageClass: "handwritten", idempotencyKey: idem(),
    });
    d = await previewDispatch(agent, d.id);
    return { agent, d };
  }

  it("aperçu partenaire non activé : aperçu local non contractuel clairement signalé (test 6)", async () => {
    const { d } = await thanks();
    expect(d.status).toBe("PREVIEWED");
    expect(d.incident).toMatch(/non contractuel/);
    expect(d.previewAssetId).not.toBeNull();
    expect(h.ms.calls.some((c) => c.url.includes("/partners/"))).toBe(false);
  });

  it("webhooks Manuscry : rapprochement via l'API, doublon et QR ignorés, lettre à valider (tests 13, 14)", async () => {
    const { agent, d: d0 } = await thanks();
    let d = await requestApproval(agent, d0.id);
    d = await approveDispatch(h.as("manager", ["manager"]), d.id);
    await drain(1);
    const letter = h.ms.generate(d.reference, "validating");
    const ready = JSON.stringify({ event: "letter_ready_for_validation", timestamp: "2026-11-16T10:00:00Z", campaign_id: "cmp-manual", data: { lead: { id: letter.lead_id, lead_identifier: d.reference, firstname: "Alice" } } });
    expect((await ingestWebhook(h.deps, "manuscry", s.msWebhookToken, ready)).result).toBe("accepted");
    expect((await ingestWebhook(h.deps, "manuscry", s.msWebhookToken, ready)).result).toBe("duplicate");
    await drain(1);
    const tasks = await h.root.find<{ kind: string }>("postal_human_tasks", { dispatchId: d.id, status: "open" });
    expect(tasks.map((t) => t.kind)).toContain("provider_validation");
    expect((await getDispatch(h.as("manager", ["manager"]), d.id)).providerLetterId).toBe(letter.id);

    letter.status = "delivered";
    const delivered = JSON.stringify({ event: "letter_delivered", timestamp: "2026-11-20T10:00:00Z", data: { letter: { id: letter.id, lead_identifier: d.reference } } });
    await ingestWebhook(h.deps, "manuscry", s.msWebhookToken, delivered);
    await drain(1);
    expect((await getDispatch(h.as("manager", ["manager"]), d.id)).status).toBe("DELIVERED");
    // Événement « envoyé » reçu en retard : pas de régression.
    letter.status = "sending";
    await ingestWebhook(h.deps, "manuscry", s.msWebhookToken, JSON.stringify({ event: "letter_sent", timestamp: "2026-11-18T10:00:00Z", data: { letter: { id: letter.id, lead_identifier: d.reference } } }));
    await drain(1);
    expect((await getDispatch(h.as("manager", ["manager"]), d.id)).status).toBe("DELIVERED");
    const qr = await ingestWebhook(h.deps, "manuscry", s.msWebhookToken, JSON.stringify({ event: "qr_code_scanned", timestamp: "x", data: { scan: { letter_id: letter.id, lead_identifier: d.reference, scan_location: { city: "Paris" } } } }));
    expect(qr.result).toBe("ignored");
  });

  it("timeout après ajout de contact : rapprochement par identifier, jamais de second POST (test 15)", async () => {
    const { agent, d: d0 } = await thanks();
    let d = await requestApproval(agent, d0.id);
    d = await approveDispatch(h.as("manager", ["manager"]), d.id);
    h.ms.fail(/\/contacts$/, { kind: "timeout_after_send" }, { method: "POST" });
    await drain(1);
    expect((await getDispatch(h.as("manager", ["manager"]), d.id)).status).toBe("UNKNOWN_SUBMISSION_STATUS");
    h.clock.advance(10 * 60_000);
    await drain(2);
    expect((await getDispatch(h.as("manager", ["manager"]), d.id)).status).toBe("SUBMITTED");
    expect(h.ms.calls.filter((c) => c.method === "POST" && c.url.endsWith("/contacts")).length).toBe(1);
  });

  it("champ requis manquant côté campagne (422) : tâche humaine avec champs", async () => {
    h.ms.campaigns["cmp-manual"]!.fields.push({ key: "ville_centre", required: true, is_custom: true });
    const { agent, d: d0 } = await thanks();
    let d = await requestApproval(agent, d0.id);
    d = await approveDispatch(h.as("manager", ["manager"]), d.id);
    await drain(1);
    const cur = await getDispatch(h.as("manager", ["manager"]), d.id);
    expect(cur.status).toBe("FAILED_PROVIDER");
    expect(cur.incident).toContain("ville_centre");
  });

  it("modèle relationnel : termes santé et ai_context médical refusés dès la création de version (test 5)", async () => {
    const t = await createTemplate(h.as("admin", ["manager"]), { legalEntityId: LE_A, type: "handwritten", provider: "manuscry", purpose: "relationship", title: "x" });
    await expect(addTemplateVersion(h.as("admin", ["manager"]), t.id, { allowedMergeFields: [], content: { body: "Comment va votre appareillage ?" }, declaredSensitivity: "personal_non_health", provider: { campaignId: "cmp-manual", fieldMap: {} } })).rejects.toThrow(/santé/);
    await expect(addTemplateVersion(h.as("admin", ["manager"]), t.id, { allowedMergeFields: ["patient.prenom"], content: { body: "Bonjour" }, declaredSensitivity: "personal_non_health", provider: { campaignId: "cmp-manual", fieldMap: { prenom: "patient.prenom" }, staticAiContext: "Patient malentendant, ordonnance récente" } })).rejects.toThrow(/santé/);
    await expect(addTemplateVersion(h.as("admin", ["manager"]), t.id, { allowedMergeFields: ["patient.prenom"], content: { body: "Bonjour" }, declaredSensitivity: "personal_non_health", provider: { campaignId: "cmp-manual", fieldMap: { inexistant: "patient.prenom", prenom: "patient.prenom" } } })).rejects.toThrow(/absentes de la campagne/);
  });
});
