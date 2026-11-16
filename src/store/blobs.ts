/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Le rangement des fichiers (PDF, preuves). Chaque fichier est chiffré avant d'être écrit :
 * sans la clé, il est illisible.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uuid } from "../lib/util.js";

/**
 * Stockage des documents (PDF générés, pièces, preuves). Les implémentations
 * doivent chiffrer au repos ; l'accès passe toujours par le backend après
 * contrôle des droits — jamais d'URL directe exposée.
 */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<string>;
  get(key: string): Promise<Uint8Array>;
  /** Suppression définitive (purge de conservation). */
  delete(key: string): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  private m = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array) {
    const k = uuid();
    this.m.set(k, new Uint8Array(bytes));
    return k;
  }
  async get(key: string) {
    const v = this.m.get(key);
    if (!v) throw new Error("Blob introuvable");
    return new Uint8Array(v);
  }
  async delete(key: string) {
    this.m.delete(key);
  }
}

/** Fichiers chiffrés AES-256-GCM (clé 32 octets en base64, issue du gestionnaire de secrets). */
export class EncryptedFsBlobStore implements BlobStore {
  private readonly key: Buffer;
  constructor(
    private readonly dir: string,
    keyBase64: string,
  ) {
    this.key = Buffer.from(keyBase64, "base64");
    if (this.key.length !== 32) throw new Error("Clé de chiffrement invalide (32 octets attendus)");
  }
  async put(bytes: Uint8Array) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const k = uuid();
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(k));
    const enc = Buffer.concat([c.update(bytes), c.final()]);
    await writeFile(join(this.dir, k), Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
    return k;
  }
  async get(key: string) {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error("Clé invalide");
    const raw = await readFile(join(this.dir, key));
    const d = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(key));
    d.setAuthTag(raw.subarray(12, 28));
    return new Uint8Array(Buffer.concat([d.update(raw.subarray(28)), d.final()]));
  }
  async delete(key: string) {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error("Clé invalide");
    await rm(join(this.dir, key), { force: true });
  }
}
