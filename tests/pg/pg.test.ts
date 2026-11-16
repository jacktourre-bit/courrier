import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import { PgDb } from "../../src/store/pg.js";
import { systemScope } from "../../src/store/db.js";
import { harness, idem, seed, LE_A, LE_B, T } from "../helpers.js";
import { approveDispatch, createDispatch, getDispatch, previewDispatch, requestApproval } from "../../src/services/dispatch-service.js";
import { runOutboxOnce } from "../../src/services/worker.js";
import { runBirthdayScheduler, createCampaign, approveCampaign } from "../../src/services/campaigns.js";
import type { Dispatch } from "../../src/domain/types.js";

/**
 * Tests sur un vrai PostgreSQL (RLS, contraintes, triggers). Activés par
 * POSTAL_TEST_PG=1 avec PG_ADMIN_URL (propriétaire) et PG_APP_URL (rôle applicatif).
 */
const enabled = process.env.POSTAL_TEST_PG === "1";
const ADMIN = process.env.PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postal_test";
const APP = process.env.PG_APP_URL ?? "postgres://postal_app:postal_app@127.0.0.1:55432/postal_test";

describe.skipIf(!enabled)("PostgreSQL", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    for (let i = 0; i < 5; i++) await migrate(ADMIN, { down: true }).catch(() => {});
    const applied = await migrate(ADMIN, { appRole: "postal_app" });
    expect(applied).toEqual(["0001_postal_module.up.sql", "0002_webhook_payloads.up.sql"]);
    pool = new pg.Pool({ connectionString: APP });
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("parcours Service Postal complet sur PgDb (RLS active, rôle applicatif)", async () => {
    const h = harness({}, new PgDb(pool, systemScope()));
    const s = await seed(h);
    const agent = h.as("agent", ["assistante"]);
    let d = await createDispatch(agent, {
      legalEntityId: LE_A, centerId: null, sourceType: "organization_file", sourceId: null, subject: { type: "organization", id: s.orgId },
      recipient: { organizationId: s.orgId }, purpose: "administrative", templateVersionId: s.formalVersionId, postageClass: "ecopli", idempotencyKey: idem(),
    });
    d = await previewDispatch(agent, d.id);
    d = await requestApproval(agent, d.id);
    d = await approveDispatch(h.as("manager", ["manager"]), d.id);
    await runOutboxOnce(h.deps);
    expect((await getDispatch(h.as("manager", ["manager"]), d.id)).status).toBe("SUBMITTED");

    // RLS : la société B ne voit rien, même en requête SQL directe.
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('postal.tenant_id', $1, true), set_config('postal.legal_entity_ids', $2, true)", [T, LE_B]);
      expect((await c.query("SELECT count(*)::int n FROM postal_dispatches")).rows[0].n).toBe(0);
      await c.query("SELECT set_config('postal.legal_entity_ids', $1, true)", [LE_A]);
      expect((await c.query("SELECT count(*)::int n FROM postal_dispatches")).rows[0].n).toBeGreaterThan(0);
      // Insertion forcée dans une autre société : refusée par la RLS.
      await expect(c.query("INSERT INTO postal_human_tasks (id, tenant_id, legal_entity_id, kind, message, status, created_at) VALUES (gen_random_uuid(), $1, $2, 'x', 'x', 'open', now())", [T, LE_B])).rejects.toThrow(/row-level security/);
      await c.query("ROLLBACK");
      // Sans contexte : rien n'est visible.
      expect((await c.query("SELECT count(*)::int n FROM postal_dispatches")).rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });

  it("journal d'audit et approbations immuables", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('postal.is_system', 'on', true)");
      await expect(c.query("UPDATE postal_audit_logs SET action = 'x'")).rejects.toThrow(/ajout seul/);
      await c.query("ROLLBACK");
      await c.query("BEGIN");
      await c.query("SELECT set_config('postal.is_system', 'on', true)");
      await expect(c.query("DELETE FROM postal_approvals")).rejects.toThrow(/ajout seul/);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("anniversaire : unicité garantie par la base même en cas d'exécutions concurrentes", async () => {
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("TRUNCATE postal_campaign_recipients, postal_outbox, postal_events, postal_attachments, postal_evidence, postal_approvals, postal_dispatches CASCADE").catch(async () => {
      // tables immuables : on repart d'un schéma neuf
      await migrate(ADMIN, { down: true });
      await migrate(ADMIN, { down: true });
      await migrate(ADMIN, { appRole: "postal_app" });
    });
    await admin.end();
    const h = harness({}, new PgDb(pool, systemScope()));
    const s = await seed(h, { le: "00000000-0000-4000-8000-0000000000a9" });
    const mgr = h.as("manager", ["manager"], "00000000-0000-4000-8000-0000000000a9");
    const c = await createCampaign(mgr, { legalEntityId: "00000000-0000-4000-8000-0000000000a9", centerId: null, type: "birthday", templateVersionId: s.bdayVersionId, purpose: "relationship", rules: { recurrenceOwner: "saas" } });
    await approveCampaign(h.as("director", ["direction"], "00000000-0000-4000-8000-0000000000a9"), c.id);
    const [r1, r2] = await Promise.all([runBirthdayScheduler(h.deps), runBirthdayScheduler(h.deps)]);
    expect(r1.dispatched + r2.dispatched).toBe(1);
    await runOutboxOnce(h.deps);
    await runOutboxOnce(h.deps);
    expect(h.ms.contacts).toHaveLength(1);
    const rows = await h.root.find<Dispatch>("postal_dispatches", { provider: "manuscry", legalEntityId: "00000000-0000-4000-8000-0000000000a9" });
    expect(rows).toHaveLength(1);
  });

  it("migration réversible", async () => {
    expect(await migrate(ADMIN, { down: true })).toEqual(["down:0002_webhook_payloads.up.sql"]);
    expect(await migrate(ADMIN, { down: true })).toEqual(["down:0001_postal_module.up.sql"]);
    const c = new pg.Client({ connectionString: ADMIN });
    await c.connect();
    expect((await c.query("SELECT count(*)::int n FROM pg_tables WHERE tablename LIKE 'postal\\_%' AND tablename <> 'postal_schema_migrations'")).rows[0].n).toBe(0);
    await c.end();
    await migrate(ADMIN, { appRole: "postal_app" });
  });
});
