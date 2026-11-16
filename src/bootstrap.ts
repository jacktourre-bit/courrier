import { configFromEnv } from "./config/flags.js";
import { createLogger } from "./lib/logger.js";
import { noScanner } from "./lib/files.js";
import { systemClock } from "./lib/util.js";
import { envSecretStore } from "./providers/types.js";
import { ServicePostalAdapter } from "./providers/servicepostal/adapter.js";
import { ManuscryAdapter } from "./providers/manuscry/adapter.js";
import { createPool, PgDb } from "./store/pg.js";
import { EncryptedFsBlobStore } from "./store/blobs.js";
import { systemScope } from "./store/db.js";
import type { Deps } from "./services/context.js";

/** Assemblage des dépendances à partir de l'environnement (voir .env.example). */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): Deps {
  const config = configFromEnv(env);
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Variable d'environnement manquante : ${k}`);
    return v;
  };
  const secrets = envSecretStore(env);
  const prod = config.flags.POSTAL_PRODUCTION_PROVIDERS_ALLOWED;
  return {
    db: new PgDb(createPool(need("DATABASE_URL")), systemScope()),
    blobs: new EncryptedFsBlobStore(need("POSTAL_BLOB_DIR"), need("POSTAL_BLOB_KEY")),
    adapters: {
      servicepostal: new ServicePostalAdapter({ secrets, allowProduction: prod }),
      // Pas de sandbox Manuscry documentée : écritures autorisées uniquement en production explicite.
      manuscry: new ManuscryAdapter({ secrets, allowWrites: prod }),
    },
    config,
    clock: systemClock,
    logger: createLogger(),
    scanner: noScanner(config.allowUnscannedUploads),
  };
}
