import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { signV4, S3BlobStore } from "../../src/store/s3.js";

/** Valeurs de référence calculées avec botocore 1.44.4 (S3SigV4Auth), mêmes entrées. */
const U = "https://s3.gra.io.cloud.ovh.net/mon-bucket/postal/1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const CASES: [string, string, string, Record<string, string>, string][] = [
  ["PUT", U, "donnees chiffrees", { "content-type": "application/octet-stream" }, "db351d1737e4bf98916f087c47223d6211a1c170d4a2ede67f1bc1110f08635e"],
  ["GET", U, "", {}, "f661369574153bd034a9e402ab0d473fd0bb643cc9819fbbf48bb28d0a09fab6"],
  ["GET", "https://s3.gra.io.cloud.ovh.net/mon-bucket?list-type=2&prefix=a%20b%2Fc&delimiter=%2F", "", {}, "190dc6d4fe4e04709406af69168dffd3e05082420142d7f14b7db40c8bf7d23d"],
  ["DELETE", "https://s3.gra.io.cloud.ovh.net/mon-bucket/postal/x%20y", "", {}, "a2edc2e84dc6a628fc6fd0bc45d2207d6466291174670ff16f8037d5c5be3e90"],
];

describe("Stockage objet compatible S3 (OVHcloud Object Storage)", () => {
  it("signature SigV4 identique à l'implémentation de référence AWS (botocore)", () => {
    for (const [method, url, body, headers, expected] of CASES) {
      const h = signV4({
        method, url: new URL(url), headers, payloadHash: createHash("sha256").update(body).digest("hex"), region: "gra", service: "s3",
        accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE", date: new Date("2026-11-16T12:00:00Z"),
      });
      expect(h.authorization!.slice(-64)).toBe(expected);
    }
  });

  it("chiffrement côté application : le stockeur ne reçoit jamais le clair ; aller-retour et suppression", async () => {
    const objects = new Map<string, Uint8Array>();
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (!auth.startsWith("AWS4-HMAC-SHA256 Credential=AK/")) return new Response("", { status: 403 });
      if (init?.method === "PUT") { objects.set(u.pathname, new Uint8Array(init.body as Uint8Array)); return new Response("", { status: 200 }); }
      if (init?.method === "DELETE") { objects.delete(u.pathname); return new Response(null, { status: 204 }); }
      const o = objects.get(u.pathname);
      return o ? new Response(o, { status: 200 }) : new Response("", { status: 404 });
    }) as typeof fetch;
    const store = new S3BlobStore({ endpoint: "https://s3.gra.io.cloud.ovh.net", region: "gra", bucket: "b", accessKeyId: "AK", secretAccessKey: "SK", encryptionKeyBase64: Buffer.alloc(32, 7).toString("base64"), prefix: "postal/", fetchImpl: fake });
    const clear = new TextEncoder().encode("%PDF-1.7 compte rendu confidentiel");
    const key = await store.put(clear);
    const stored = [...objects.values()][0]!;
    expect(Buffer.from(stored).includes(Buffer.from("confidentiel"))).toBe(false);
    expect([...objects.keys()][0]).toBe(`/b/postal/${key}`);
    expect(Buffer.from(await store.get(key)).toString()).toContain("confidentiel");
    // Intégrité : un objet altéré est rejeté.
    stored[40] = stored[40]! ^ 1;
    await expect(store.get(key)).rejects.toThrow();
    await store.delete(key);
    expect(objects.size).toBe(0);
  });
});
