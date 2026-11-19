/**
 * Applique (ou annule avec --down) les migrations SQL de db/migrations.
 *   MIGRATION_DATABASE_URL : rôle propriétaire du schéma (DDL)
 *   POSTAL_APP_ROLE        : rôle applicatif (sans BYPASSRLS) recevant les droits DML
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const dir = join(import.meta.dirname, "..", "db", "migrations");

export async function migrate(url: string, opts: { down?: boolean; appRole?: string } = {}): Promise<string[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("CREATE TABLE IF NOT EXISTS postal_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query("SELECT name FROM postal_schema_migrations")).rows.map((r) => r.name as string));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".up.sql")).toSorted();
    const applied: string[] = [];
    if (opts.down) {
      const last = files.filter((f) => done.has(f)).at(-1);
      if (last) {
        await c.query(await readFile(join(dir, last.replace(".up.sql", ".down.sql")), "utf8"));
        await c.query("DELETE FROM postal_schema_migrations WHERE name = $1", [last]);
        applied.push(`down:${last}`);
      }
      return applied;
    }
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query(await readFile(join(dir, f), "utf8"));
      await c.query("INSERT INTO postal_schema_migrations (name) VALUES ($1)", [f]);
      applied.push(f);
    }
    if (opts.appRole) {
      if (!/^[a-z_][a-z0-9_]*$/.test(opts.appRole)) throw new Error("Nom de rôle invalide");
      const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'postal\\_%' AND tablename <> 'postal_schema_migrations'")).rows.map((r) => r.tablename as string);
      for (const t of tables) await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${t}" TO "${opts.appRole}"`);
    }
    return applied;
  } finally {
    await c.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL requis");
  migrate(url, { down: process.argv.includes("--down"), appRole: process.env.POSTAL_APP_ROLE }).then((r) => console.log(r.length ? r.join("\n") : "à jour"));
}
