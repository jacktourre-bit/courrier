/*
 * ════════════════════════════════ EN CLAIR ════════════════════════════════
 * Fabrique la lettre en PDF (format A4) : expéditeur, destinataire placé pour la fenêtre de
 * l'enveloppe, objet, corps, signature, liste des pièces jointes.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PostalAddress, TemplateBlockContent } from "../domain/types.js";
import { renderText } from "../domain/merge-fields.js";

/**
 * Génération d'une lettre formelle A4 (PDF figé). Blocs normalisés : expéditeur,
 * destinataire, lieu/date, objet, références, corps, formule, signature, annexes.
 * Le pavé destinataire est positionné pour une enveloppe à fenêtre DL standard ;
 * Service Postal insère de toute façon un porte-adresse (`insertion_page_adresse`).
 */
const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 56.7; // 2 cm

/** Les polices standard PDF sont en WinAnsi : on remplace les caractères non encodables. */
function sanitize(s: string, font: PDFFont): string {
  let out = "";
  for (const ch of s.replace(/\t/g, "    ")) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += ch === " " || ch === " " ? " " : "?";
    }
  }
  return out;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (!para.trim()) {
      lines.push("");
      continue;
    }
    let cur = "";
    for (const word of para.split(/\s+/)) {
      const cand = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(cand, size) <= width) cur = cand;
      else {
        if (cur) lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

export const addressLines = (a: PostalAddress): string[] =>
  [
    [a.civility, a.firstName, a.lastName].filter(Boolean).join(" "),
    a.company,
    a.service,
    a.line1,
    a.line2,
    a.line3,
    `${a.postalCode} ${a.city}`,
    a.country !== "FR" ? a.country : null,
  ].filter((l): l is string => !!l && l.trim().length > 0);

export interface RenderInput {
  sender: { businessName: string; address: PostalAddress; contact?: string | null };
  recipient: PostalAddress;
  content: TemplateBlockContent;
  values: Record<string, string>;
  placeAndDate: string;
  reference: string;
}

// EN CLAIR : Produit le PDF. Le même contenu donne toujours exactement le même fichier, donc la même
// empreinte : on peut prouver ce qui a été approuvé.
export async function renderFormalLetter(i: RenderInput): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const doc = await PDFDocument.create();
  doc.setTitle(i.content.subject ? renderText(i.content.subject, i.values) : "Courrier");
  doc.setProducer("courrier-postal-module");
  doc.setCreationDate(new Date(0)); // rendu déterministe : même contenu => même hachage
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 10.5;
  const lh = size * 1.45;
  const width = A4.w - 2 * MARGIN;

  let page: PDFPage = doc.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN;
  const draw = (t: string, x: number, f = font, s = size) => page.drawText(sanitize(t, f), { x, y, size: s, font: f, color: rgb(0, 0, 0) });
  const newPage = () => {
    page = doc.addPage([A4.w, A4.h]);
    y = A4.h - MARGIN;
  };
  const line = (t: string, f = font, s = size, x = MARGIN) => {
    if (y < MARGIN + lh * 2) newPage();
    draw(t, x, f, s);
    y -= lh;
  };

  // Expéditeur (en-tête)
  line(i.sender.businessName, bold);
  for (const l of addressLines(i.sender.address).slice(1)) line(l);
  if (i.sender.contact) line(i.sender.contact);

  // Destinataire : fenêtre DL (≈ 11 cm du bord gauche, 4,5 à 8 cm du haut)
  y = A4.h - 128;
  for (const l of addressLines(i.recipient)) {
    draw(l, 311);
    y -= lh;
  }

  y = A4.h - 250;
  line(i.placeAndDate, font, size, 311);
  y -= lh * 0.5;
  line(`Réf. : ${i.reference}`);
  for (const r of i.content.references ?? []) line(renderText(r, i.values));
  if (i.content.subject) {
    y -= lh * 0.5;
    for (const l of wrap(`Objet : ${renderText(i.content.subject, i.values)}`, bold, size, width)) line(l, bold);
  }
  y -= lh;
  for (const l of wrap(sanitize(renderText(i.content.body, i.values), font), font, size, width)) line(l);
  if (i.content.closing) {
    y -= lh * 0.5;
    for (const l of wrap(sanitize(renderText(i.content.closing, i.values), font), font, size, width)) line(l);
  }
  y -= lh * 2;
  if (i.content.signatureName) line(renderText(i.content.signatureName, i.values), bold, size, 311);
  if (i.content.signatureTitle) line(renderText(i.content.signatureTitle, i.values), font, size, 311);
  if (i.content.annexesList?.length) {
    y -= lh;
    line("Pièces jointes :", bold);
    for (const a of i.content.annexesList) line(`- ${renderText(a, i.values)}`);
  }

  const pages = doc.getPages();
  pages.forEach((p, idx) => {
    if (pages.length > 1) p.drawText(`${idx + 1}/${pages.length}`, { x: A4.w - MARGIN - 20, y: MARGIN / 2, size: 8, font });
  });
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageCount: pages.length };
}
