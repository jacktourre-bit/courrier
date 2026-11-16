/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Contrôle des fichiers déposés par les utilisateurs : on vérifie le vrai type (PDF ou Word)
 * en lisant le début du fichier, on passe l'antivirus, on compte les pages.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { PDFDocument } from "pdf-lib";
import { PostalError } from "./errors.js";

export type AllowedMime = "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// EN CLAIR : Regarde les premiers octets du fichier pour savoir si c'est vraiment un PDF ou un DOCX
// (on ne croit pas l'extension).
/** Vérifie la signature binaire (magic bytes) — le MIME déclaré n'est jamais cru seul. */
export function sniffMime(bytes: Uint8Array): AllowedMime | null {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-") return "application/pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    // Archive ZIP : on exige la présence de la partie Word principale.
    const ascii = Buffer.from(bytes.slice(0, Math.min(bytes.length, 64 * 1024))).toString("latin1");
    if (ascii.includes("word/") || ascii.includes("[Content_Types].xml")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
  }
  return null;
}

// EN CLAIR : Compte les pages d'un PDF.
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    throw new PostalError("FILE_REJECTED", "PDF illisible ou chiffré");
  }
}

/** Analyse antivirale : port à brancher sur l'outil de l'hébergeur (ClamAV, service cloud…). */
export interface MalwareScanner {
  readonly configured: boolean;
  scan(bytes: Uint8Array): Promise<{ clean: boolean; engine: string }>;
}

// EN CLAIR : Antivirus « absent » : refuse tout en production, accepte en test. À remplacer par un
// vrai antivirus.
/** Scanner absent : refuse tout en production, accepte en dev/test avec traçabilité. */
export function noScanner(allowUnscanned: boolean): MalwareScanner {
  return {
    configured: false,
    async scan() {
      if (!allowUnscanned) throw new PostalError("FILE_REJECTED", "Aucun antivirus configuré : dépôt de fichier refusé");
      return { clean: true, engine: "none(dev)" };
    },
  };
}

// EN CLAIR : Enchaîne tous les contrôles d'un fichier déposé : taille, type réel, antivirus, pages.
export async function validateUpload(
  bytes: Uint8Array,
  declaredMime: string,
  scanner: MalwareScanner,
  maxBytes = 15 * 1024 * 1024,
): Promise<{ mime: AllowedMime; pageCount: number | null; engine: string }> {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new PostalError("FILE_REJECTED", "Taille de fichier invalide");
  const mime = sniffMime(bytes);
  if (!mime) throw new PostalError("FILE_REJECTED", "Format non autorisé (PDF ou DOCX uniquement)");
  if (declaredMime && declaredMime !== mime) throw new PostalError("FILE_REJECTED", "Le type déclaré ne correspond pas au contenu");
  const { clean, engine } = await scanner.scan(bytes);
  if (!clean) throw new PostalError("FILE_REJECTED", "Fichier rejeté par l'antivirus");
  const pageCount = mime === "application/pdf" ? await pdfPageCount(bytes) : null;
  return { mime, pageCount, engine };
}
