import { allOff, type FeatureFlags, type ModuleConfig } from "../src/config/flags.js";
import { MemoryDb, systemScope, type Db } from "../src/store/db.js";
import { MemoryBlobStore } from "../src/store/blobs.js";
import { createLogger } from "../src/lib/logger.js";
import { noScanner } from "../src/lib/files.js";
import { ServicePostalAdapter } from "../src/providers/servicepostal/adapter.js";
import { ManuscryAdapter } from "../src/providers/manuscry/adapter.js";
import type { SecretStore } from "../src/providers/types.js";
import type { Ctx, Deps } from "../src/services/context.js";
import { ROLE_PERMISSIONS, type Role } from "../src/domain/policy.js";
import type { PostalAddress } from "../src/domain/types.js";
import { FakeManuscry, FakeServicePostal } from "./fakes.js";
import { addRecipientAddress, createConnection, upsertOrganization, upsertSenderProfile, upsertSubject } from "../src/services/admin.js";
import { addTemplateVersion, approveTemplateVersion, createTemplate } from "../src/services/templates.js";
import { setPreference } from "../src/services/preferences.js";

export const T = "00000000-0000-4000-8000-000000000001";
export const LE_A = "00000000-0000-4000-8000-0000000000a1";
export const LE_B = "00000000-0000-4000-8000-0000000000b1";
export const CENTER_A = "00000000-0000-4000-8000-0000000000c1";

export class TestClock {
  constructor(public t = new Date("2026-11-16T09:00:00Z")) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
  set(iso: string) {
    this.t = new Date(iso);
  }
}

export interface Harness {
  deps: Deps;
  sp: FakeServicePostal;
  ms: FakeManuscry;
  clock: TestClock;
  logs: string[];
  root: Db;
  as(userId: string, roles: Role[], le?: string, extra?: string[]): Ctx;
}

export function harness(flags: Partial<FeatureFlags> = {}, root?: Db): Harness {
  const sp = new FakeServicePostal();
  const ms = new FakeManuscry();
  const clock = new TestClock();
  const logs: string[] = [];
  const secrets: SecretStore = { get: async (ref) => (ref === "env:SP_KEY" ? sp.apiKey : ref === "env:MS_KEY" ? ms.apiKey : "wrong") };
  const both: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return u.includes("manuscry.com") ? ms.fetch(input, init) : sp.fetch(input, init);
  }) as typeof fetch;
  const config: ModuleConfig = {
    flags: { ...allOff(), POSTAL_MODULE_ENABLED: true, MANUSCRY_ENABLED: true, SERVICEPOSTAL_ENABLED: true, BIRTHDAY_AUTOMATION_ENABLED: true, ...flags },
    serviceVatRate: 0.2,
    outboxMaxAttempts: 5,
    evidenceLinkTtlSeconds: 300,
    allowUnscannedUploads: true,
    allowSelfApprovalRelationship: false,
  };
  const db = root ?? new MemoryDb(systemScope());
  const deps: Deps = {
    db,
    blobs: new MemoryBlobStore(),
    adapters: {
      servicepostal: new ServicePostalAdapter({ secrets, fetchImpl: both, allowProduction: false, skipDnsCheck: true }),
      manuscry: new ManuscryAdapter({ secrets, fetchImpl: both, allowWrites: true, clock: clock.now }),
    },
    config,
    clock,
    logger: createLogger((l) => logs.push(l), "debug"),
    scanner: noScanner(true),
    fetchImpl: both,
    skipDnsCheck: true,
  };
  const as = (userId: string, roles: Role[], le = LE_A, extra: string[] = []): Ctx => {
    const scope = { tenantId: T, legalEntityIds: [le], centerIds: "*" as const, userId };
    return { ...deps, scope, db: db.withScope(scope), permissions: new Set([...roles.flatMap((r) => ROLE_PERMISSIONS[r]), ...extra]) };
  };
  return { deps, sp, ms, clock, logs, root: db, as };
}

export const FR_ADDRESS: PostalAddress = { civility: "Mme", firstName: "Alice", lastName: "Martin", line1: "12 rue des Lilas", postalCode: "75011", city: "Paris", country: "FR" };

export interface Seed {
  patientId: string;
  addressId: string;
  orgId: string;
  publicOrgId: string;
  formalTemplateId: string;
  formalVersionId: string;
  legalVersionId: string;
  bdayTemplateId: string;
  bdayVersionId: string;
  manualVersionId: string;
  spWebhookToken: string;
  msWebhookToken: string;
}

/** Jeu de données fictif complet pour la société A. */
export async function seed(h: Harness, opts: { birthDate?: string; le?: string } = {}): Promise<Seed> {
  const le = opts.le ?? LE_A;
  const admin = h.as("admin", ["administrateur", "manager"], le, ["postal.templates.approve"]);
  const reviewer = h.as("reviewer", ["direction"], le);
  const sp = await createConnection(admin, { legalEntityId: le, provider: "servicepostal", environment: "sandbox", credentialsSecretRef: "env:SP_KEY", settings: { documentHostSuffixes: ["servicepostal.com"], billingEntity: "Centre A" } });
  const ms = await createConnection(admin, { legalEntityId: le, provider: "manuscry", environment: "sandbox", credentialsSecretRef: "env:MS_KEY", settings: { unitCostTtcCents: 450 } });
  await upsertSenderProfile(admin, { legalEntityId: le, centerId: null, businessName: "Audition Démo SAS", envelopeDisplayName: "Centre Démo", postalAddressJson: { line1: "1 place de la Gare", postalCode: "69002", city: "Lyon", country: "FR" }, contact: "04 00 00 00 00", signatureAssetId: null, defaultProvider: null, active: true });
  const subject = await upsertSubject(admin, {
    legalEntityId: le, centerId: CENTER_A, type: "patient", civility: "Mme", firstName: "Alice", lastName: "Martin", company: null,
    birthDate: opts.birthDate ?? "1960-12-01", birthDateReliable: true, deceased: false, archived: false, litigation: false, hasLegalRepresentative: false, publicReference: "DOS-0001",
  });
  const addr = await addRecipientAddress(admin, { legalEntityId: le, subjectType: "patient", subjectId: subject.id, address: FR_ADDRESS, verifiedAt: "2026-10-01T00:00:00Z", verificationSource: "patient" });
  const org = await upsertOrganization(admin, {
    legalEntityId: le, centerId: null, category: "bailleur", name: "SCI Démo", branch: null, service: "Gestion locative",
    addressJson: { company: "SCI Démo", line1: "5 avenue Foch", postalCode: "69006", city: "Lyon", country: "FR" },
    channelPolicy: { recommendedChannel: "courrier", postalAccepted: true }, verifiedAt: "2026-10-01T00:00:00Z", source: "bail", active: true,
  });
  const cpam = await upsertOrganization(admin, {
    legalEntityId: null, centerId: null, category: "cpam", name: "CPAM du Rhône", branch: null, service: null,
    addressJson: { company: "CPAM du Rhône", line1: "Service des prestations", postalCode: "69907", city: "Lyon", country: "FR" },
    channelPolicy: { recommendedChannel: "portail / postal", postalAccepted: true }, verifiedAt: "2026-10-01T00:00:00Z", source: "site officiel", active: true,
  });

  const formal = await createTemplate(admin, { legalEntityId: le, type: "formal", provider: "servicepostal", purpose: "administrative", title: "Courrier administratif" });
  const fv = await addTemplateVersion(admin, formal.id, {
    allowedMergeFields: ["destinataire.societe", "societe.nom", "date.jour"],
    content: { subject: "Demande de document", body: "Madame, Monsieur,\n\nNous vous prions de bien vouloir nous transmettre le document demandé.\n\n{{societe.nom}}", closing: "Veuillez agréer nos salutations distinguées.", signatureName: "La direction" },
    declaredSensitivity: "personal_non_health",
  });
  await approveTemplateVersion(reviewer, fv.id);
  const legal = await createTemplate(admin, { legalEntityId: le, type: "formal", provider: "servicepostal", purpose: "legal", title: "Mise en demeure" });
  const lv = await addTemplateVersion(admin, legal.id, { allowedMergeFields: ["societe.nom"], content: { subject: "Mise en demeure", body: "Par la présente, {{societe.nom}} vous met en demeure.", signatureName: "La direction", annexesList: ["Copie du bail"] }, declaredSensitivity: "personal_non_health" });
  await approveTemplateVersion(reviewer, lv.id);

  const bday = await createTemplate(admin, { legalEntityId: le, type: "handwritten", provider: "manuscry", purpose: "relationship", title: "Anniversaire" });
  const bv = await addTemplateVersion(admin, bday.id, {
    allowedMergeFields: ["patient.prenom"],
    content: { body: "Joyeux anniversaire {{patient.prenom}} ! Toute l'équipe vous souhaite une belle journée." },
    declaredSensitivity: "personal_non_health",
    provider: { campaignId: "cmp-bday", fieldMap: { prenom: "patient.prenom" }, staticAiContext: null },
  });
  await approveTemplateVersion(reviewer, bv.id);
  const manual = await createTemplate(admin, { legalEntityId: le, type: "handwritten", provider: "manuscry", purpose: "relationship", title: "Remerciement" });
  const mv = await addTemplateVersion(admin, manual.id, {
    allowedMergeFields: ["patient.prenom"],
    content: { body: "Merci {{patient.prenom}} pour votre confiance." },
    declaredSensitivity: "personal_non_health",
    provider: { campaignId: "cmp-manual", fieldMap: { prenom: "patient.prenom" } },
  });
  await approveTemplateVersion(reviewer, mv.id);

  await setPreference(admin, { legalEntityId: le, subjectType: "patient", subjectId: subject.id, purpose: "birthday", allowed: true, source: "formulaire accueil" });
  await setPreference(admin, { legalEntityId: le, subjectType: "patient", subjectId: subject.id, purpose: "relationship", allowed: true, source: "formulaire accueil" });

  const tok = (p: string) => p.split("/").pop()!;
  return {
    patientId: subject.id, addressId: addr.id, orgId: org.id, publicOrgId: cpam.id,
    formalTemplateId: formal.id, formalVersionId: fv.id, legalVersionId: lv.id, bdayTemplateId: bday.id, bdayVersionId: bv.id, manualVersionId: mv.id,
    spWebhookToken: tok(`/x/${sp.webhookToken}`), msWebhookToken: tok(`/x/${ms.webhookToken}`),
  };
}

let k = 0;
export const idem = () => `test-idem-key-${Date.now()}-${++k}`;
