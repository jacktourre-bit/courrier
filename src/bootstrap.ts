/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Assemble le module à partir de la configuration : base de données, stockage des fichiers
 * (disque ou S3/OVH), adaptateurs des prestataires.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { configFromEnv } from "./config/flags.js";
import { createLogger } from "./lib/logger.js";
import { noScanner } from "./lib/files.js";
import { systemClock } from "./lib/util.js";
import { envSecretStore } from "./providers/types.js";
import { ServicePostalAdapter } from "./providers/servicepostal/adapter.js";
import { ManuscryAdapter } from "./providers/manuscry/adapter.js";
import { createPool, PgDb } from "./store/pg.js";
import { EncryptedFsBlobStore, type BlobStore } from "./store/blobs.js";
import { S3BlobStore } from "./store/s3.js";
import { systemScope } from "./store/db.js";
import type { Deps } from "./services/context.js";

// EN CLAIR : Lit la configuration et prépare toutes les pièces du module.
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
    blobs: blobStore(env, need),
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

// EN CLAIR : Choisit le rangement des fichiers : disque chiffré, ou stockage S3 (OVHcloud) chiffré.
/** `POSTAL_BLOB_BACKEND=s3` : stockage objet compatible S3 (ex. OVHcloud Object Storage) ; sinon disque chiffré. */
function blobStore(env: NodeJS.ProcessEnv, need: (k: string) => string): BlobStore {
  if (env.POSTAL_BLOB_BACKEND === "s3") {
    return new S3BlobStore({
      endpoint: need("POSTAL_S3_ENDPOINT"),
      region: need("POSTAL_S3_REGION"),
      bucket: need("POSTAL_S3_BUCKET"),
      accessKeyId: need("POSTAL_S3_ACCESS_KEY_ID"),
      secretAccessKey: need("POSTAL_S3_SECRET_ACCESS_KEY"),
      encryptionKeyBase64: need("POSTAL_BLOB_KEY"),
      prefix: env.POSTAL_S3_PREFIX ?? "postal/",
    });
  }
  return new EncryptedFsBlobStore(need("POSTAL_BLOB_DIR"), need("POSTAL_BLOB_KEY"));
}
