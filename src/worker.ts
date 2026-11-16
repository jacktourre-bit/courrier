/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Démarre le travailleur en arrière-plan : file d'envoi toutes les 15 secondes, puis une fois
 * par jour l'automate d'anniversaires et la purge de conservation.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { depsFromEnv } from "./bootstrap.js";
import { runOutboxOnce } from "./services/worker.js";
import { runBirthdayScheduler } from "./services/campaigns.js";
import { runRetentionPurge } from "./services/retention.js";
import { parisDate } from "./lib/util.js";

/** Processus worker : outbox toutes les 15 s, automate d'anniversaires une fois par jour (Europe/Paris). */
const deps = depsFromEnv();
let lastBirthdayRun = "";
let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

async function loop() {
  while (!stopping) {
    try {
      const r = await runOutboxOnce(deps, 25);
      const today = parisDate(new Date());
      if (today !== lastBirthdayRun && new Date().getUTCHours() >= 5) {
        const rep = await runBirthdayScheduler(deps);
        deps.logger.info("birthday.run", rep as unknown as Record<string, unknown>);
        deps.logger.info("retention.run", await runRetentionPurge(deps));
        lastBirthdayRun = today;
      }
      if (r.processed === 0) await new Promise((res) => setTimeout(res, 15_000));
    } catch (e) {
      deps.logger.error("worker.loop_error", { name: (e as Error)?.name });
      await new Promise((res) => setTimeout(res, 30_000));
    }
  }
}
void loop();
