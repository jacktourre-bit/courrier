/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Rangement des fichiers dans un stockage objet compatible S3, par exemple OVHcloud Object
 * Storage. Les fichiers sont chiffrés par notre application AVANT d'être envoyés : l'hébergeur
 * ne voit jamais un document en clair.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { uuid } from "../lib/util.js";
import type { BlobStore } from "./blobs.js";

/**
 * Stockage objet compatible S3 (ex. OVHcloud Object Storage), signature AWS SigV4,
 * sans SDK. Les objets sont chiffrés CÔTÉ APPLICATION (AES-256-GCM) avant envoi :
 * le stockeur ne voit jamais un document en clair, en plus de son propre chiffrement.
 *
 * L'éligibilité HDS de l'offre et de la région choisies relève du contrat avec
 * l'hébergeur : ce code ne la garantit pas.
 */
export interface S3Config {
  /** Ex. https://s3.<region>.io.cloud.ovh.net — à reprendre de la console de l'hébergeur. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Clé de chiffrement applicatif, 32 octets en base64. */
  encryptionKeyBase64: string;
  /** Préfixe des objets (ex. "postal/"). */
  prefix?: string;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

const sha256hex = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
/** Encodage URI au sens SigV4 (RFC 3986). Le chemin est encodé segment par segment. */
const uriEncode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}

// EN CLAIR : Signe chaque requête avec la clé d'accès (méthode standard « AWS SigV4 »), comme une
// signature au bas d'une lettre. Vérifiée contre la bibliothèque officielle d'AWS.
/** Signature AWS Signature Version 4 ; renvoie les en-têtes à ajouter. */
export function signV4(i: SignInput): Record<string, string> {
  const amzDate = i.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...i.headers, host: i.url.host, "x-amz-date": amzDate, "x-amz-content-sha256": i.payloadHash };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...i.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const path = i.url.pathname.split("/").map((seg) => uriEncode(decodeURIComponent(seg))).join("/") || "/";
  const canonicalRequest = [i.method, path, query, canonicalHeaders, signedHeaders, i.payloadHash].join("\n");
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${i.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, i.region), i.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": i.payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class S3BlobStore implements BlobStore {
  private readonly key: Buffer;
  constructor(private readonly c: S3Config) {
    this.key = Buffer.from(c.encryptionKeyBase64, "base64");
    if (this.key.length !== 32) throw new Error("Clé de chiffrement invalide (32 octets attendus)");
    if (!/^https:\/\//.test(c.endpoint)) throw new Error("Endpoint S3 HTTPS requis");
  }

  private url(key: string): URL {
    // Adressage par chemin (path-style), accepté par les stockages compatibles S3.
    return new URL(`${this.c.endpoint.replace(/\/$/, "")}/${this.c.bucket}/${this.c.prefix ?? ""}${key}`);
  }

  private async send(method: "PUT" | "GET" | "DELETE", key: string, body?: Uint8Array): Promise<Response> {
    const url = this.url(key);
    const payloadHash = sha256hex(body ?? new Uint8Array());
    const extra: Record<string, string> = body ? { "content-type": "application/octet-stream" } : {};
    const signed = signV4({ method, url, headers: extra, payloadHash, region: this.c.region, service: "s3", accessKeyId: this.c.accessKeyId, secretAccessKey: this.c.secretAccessKey, date: this.c.clock?.() ?? new Date() });
    return (this.c.fetchImpl ?? fetch)(url, { method, headers: { ...extra, ...signed }, body, redirect: "error" });
  }

  async put(bytes: Uint8Array): Promise<string> {
    const k = uuid();
    const iv = randomBytes(12);
    const ci = createCipheriv("aes-256-gcm", this.key, iv);
    ci.setAAD(Buffer.from(k));
    const enc = Buffer.concat([iv, Buffer.alloc(16), ci.update(bytes), ci.final()]);
    ci.getAuthTag().copy(enc, 12);
    const r = await this.send("PUT", k, new Uint8Array(enc));
    if (!r.ok) throw new Error(`Stockage objet : écriture refusée (${r.status})`);
    return k;
  }

  async get(key: string): Promise<Uint8Array> {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error("Clé invalide");
    const r = await this.send("GET", key);
    if (!r.ok) throw new Error(`Stockage objet : lecture refusée (${r.status})`);
    const raw = Buffer.from(await r.arrayBuffer());
    const d = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(key));
    d.setAuthTag(raw.subarray(12, 28));
    return new Uint8Array(Buffer.concat([d.update(raw.subarray(28)), d.final()]));
  }

  async delete(key: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error("Clé invalide");
    const r = await this.send("DELETE", key);
    if (!r.ok && r.status !== 404) throw new Error(`Stockage objet : suppression refusée (${r.status})`);
  }
}
