# Guide débutant : comment marche le module, pas à pas

Ce guide suit **un recommandé avec accusé de réception (LRAR)** depuis sa création jusqu'à l'archivage de ses preuves. Chaque extrait de code est suivi de son explication en français simple.

Dans le code lui-même, cherchez `EN CLAIR` : chaque fichier commence par un résumé et chaque fonction importante a sa phrase d'explication.

---

## 0. L'image d'ensemble

Pensez au module comme à un **secrétariat très prudent** :

| Personnage | Fichier | Rôle |
|---|---|---|
| Le guichet | `src/api/app.ts` | Reçoit les demandes de l'écran et vérifie qui vous êtes |
| Le contrôleur | `src/services/compliance.ts` | Vérifie que le courrier a le droit de partir |
| Le rédacteur | `src/services/renderer.ts` | Fabrique le PDF |
| Le chef de service | `src/services/dispatch-service.ts` | Organise les étapes et les approbations |
| Le coursier | `src/services/worker.ts` | Travaille en arrière-plan : envoie, vérifie, récupère les preuves |
| Les interprètes | `src/providers/servicepostal/…`, `src/providers/manuscry/…` | Parlent la « langue » de chaque prestataire |
| Les archives | `src/store/…` | Base de données et fichiers chiffrés |

Règle d'or partout : **en cas de doute, on bloque ou on vérifie. On n'envoie jamais à l'aveugle.**

---

## 1. Création du courrier

L'écran appelle le guichet :

```ts
api.post("/dispatches", async (c) => {
  const ctx = ctxOf(c);
  const b = parse(S.CreateDispatchSchema, await json(c));
```

- `ctxOf(c)` récupère **qui** fait la demande, pour **quelle société**, et avec **quels droits**.
- `parse(...)` vérifie que la demande a exactement la bonne forme. Un champ inconnu est refusé.

Ensuite, le chef de service prend le relais (`createDispatch`) :

```ts
requirePermission(ctx, "postal.draft");
requireEntity(ctx, input.legalEntityId, input.centerId);
const existing = await ctx.db.one<Dispatch>("postal_dispatches", { tenantId: ctx.scope.tenantId, idempotencyKey: input.idempotencyKey });
if (existing) return existing;
```

- On vérifie le droit de créer un brouillon, et que la société est bien la vôtre.
- **Anti-doublon :** si on clique deux fois sur « Envoyer », la même clé revient, et on renvoie le courrier déjà créé au lieu d'en faire un second.

```ts
const provider = routeProvider({ purpose: input.purpose, rendering: ..., postageClass: input.postageClass, ... });
```

- On choisit le prestataire. Un recommandé va forcément chez **Service Postal**. Manuscry ne fait que du manuscrit relationnel.

```ts
const comp = buildCompliance(ctx, { ... }, l, { ... });
throwIfBlocked(comp.blockers);
```

- Le contrôleur vérifie tout : adresse valide, organisme vérifié, personne non décédée, pas d'opposition, modèle approuvé, pas de doublon, et pour la santé l'autorisation DPA/HDS.
- S'il trouve un problème, **tout s'arrête** et la liste complète des raisons est renvoyée.

Enfin, le PDF est fabriqué (`renderDocument` → `renderFormalLetter`) et rangé **chiffré**, avec son empreinte SHA-256 :

```ts
const asset = await storeAsset(ctx, { ..., bytes: out.bytes, mimeType: "application/pdf", ... });
documentHash = asset.sha256;
```

> **Empreinte SHA-256 ?** C'est une sorte d'« empreinte digitale » du fichier : 64 caractères qui changent si un seul caractère du PDF change. Elle permet de prouver plus tard que le document n'a pas été modifié.

Le courrier est maintenant à l'étape **READY_FOR_PREVIEW** (prêt pour l'aperçu).

---

## 2. Aperçu et prix chez Service Postal

```ts
throwIfBlocked(await recheckCompliance(ctx, d));
const { conn, adapter } = await resolveConnection(ctx, d.legalEntityId, d.provider);
const r = await adapter.createPreview(conn, req);
```

- On **refait** les contrôles : une opposition a pu arriver entre-temps.
- On récupère la connexion Service Postal de **votre** société. En test, jamais la production.
- L'interprète Service Postal appelle `POST /lettres/previsualiser`. Il envoie le PDF et l'adresse, et reçoit un **UID** (le numéro du courrier chez eux), un lien vers l'aperçu et le prix.

```ts
const dl = await safeDownload(r.value.previewUrl, { allowedHostSuffixes: hosts, ... });
```

- On télécharge l'aperçu **nous-mêmes** et on le range chiffré. On ne montre jamais à l'utilisateur un lien du prestataire.
- `safeDownload` refuse tout lien suspect : pas HTTPS, domaine non autorisé, adresse interne.

À ce stade, **rien n'est imprimé**. Étape : **PREVIEWED**.

---

## 3. Les approbations

```ts
const approvalHash = `${await computeApprovalHash(ctx, d)}:${uuid()}`;
```

- On calcule l'empreinte de **tout ce qu'on va approuver** : le PDF, l'adresse, les pièces, le prix, les options.
- Si quelqu'un modifie quoi que ce soit après, l'empreinte ne correspond plus et les approbations sont **annulées**.

Pour un recommandé, il faut **2 approbations par 2 personnes différentes de l'auteur** (`approvalPolicyFor`) :
1. `review` : une relecture (droit `postal.approve`) ;
2. `final_legal` : la validation juridique (droit `postal.approve_legal`, rôle direction).

Pour un courrier de santé s'ajoute une 3ᵉ étape, `sensitive`, réservée à une personne habilitée nominativement.

```ts
if (next.fourEyes && (me === d.createdBy || approvals.some((a) => a.approverUserId === me))) {
  throw new PostalError("FORBIDDEN", "Principe des quatre yeux : un autre utilisateur habilité doit approuver");
}
```

- C'est le **principe des quatre yeux** : celui qui écrit ne valide pas, et la même personne ne valide pas deux fois.

Après la dernière approbation, le courrier entre dans la **file d'envoi** (l'« outbox ») :

```ts
await enqueue(ctx, d, "SUBMIT", {}, scheduledLater ? scheduleInstant(d.scheduledFor!) : nowIso(ctx));
```

---

## 4. L'envoi réel (le coursier)

Le coursier (`worker.ts`) tourne en continu. Pour la tâche `SUBMIT` :

```ts
const blockers = await recheckCompliance(ctx, d);
if (!contentMatchesApproval(await computeApprovalHash(ctx, d), d.approvalHash)) { ... }
```

- **Dernière vérification**, juste avant de partir : conformité, et le contenu est-il bien celui approuvé ?

```ts
const marked = await ctx.db.update("postal_dispatches", { id: d.id, rowVersion: d.rowVersion }, { submissionAttemptedAt: nowIso(ctx), ... });
const r = await adapter.submit(conn, req, { uid: d.providerUid, ... });
```

- On note d'abord « tentative en cours ». Si le serveur plante pendant l'envoi, on saura qu'il faut **vérifier** et non renvoyer.
- Puis l'interprète appelle `POST /lettres/{uid}/valider`. C'est **maintenant** que le courrier part en production.

Et si ça se passe mal ? (`handleSubmitFailure`)

| Ce qui arrive | Ce que fait le module |
|---|---|
| Connexion refusée avant l'envoi | On réessaie plus tard, sans risque |
| Envoyé mais pas de réponse (timeout) | Statut **INCONNU** : on demande à Service Postal si l'UID est validé, et on ne renvoie jamais à l'aveugle |
| Trop de requêtes (429) | On attend le délai demandé |
| Clé invalide, champ refusé | Tâche pour un humain |

---

## 5. Suivi et preuves du recommandé

Le coursier interroge Service Postal (`reconcileDispatch`), à chaque notification (webhook) et au plus tard toutes les 24 h :

```ts
const st = await adapter.getStatus(conn, { uid: d.providerUid, ... });
const decision = applyProviderStatus(d.status, s.mappedStatus);
```

- `getStatus` lit `GET /lettres/{uid}/infos` et `GET /lettres/{uid}/suivi`.
- `applyProviderStatus` fait avancer le courrier, **sans jamais le faire reculer**. Une information arrivée en retard est ignorée.

Les preuves sont récupérées dès qu'elles existent :

| Preuve | Source | Moment |
|---|---|---|
| PDF approuvé | fabriqué par nous | à la création |
| Aperçu prestataire | `POST /lettres/previsualiser` | avant l'approbation |
| PDF réellement imprimé | `GET /lettres/{uid}/contenu` | après l'impression |
| **Preuve de dépôt** | `GET /lettres/{uid}/preuve_depot` | après la prise en charge La Poste |
| **Accusé de réception scanné** | `GET /scannedproof/letter/{uid}` | quand le suivi indique « ar_scanne » (option activée par défaut sur les LRAR) |
| **Historique de distribution** | réponse complète de `/suivi` | à la distribution ou au retour |
| **Notifications reçues** | webhooks, copie chiffrée | à chaque réception |

```ts
if (r.kind === "NOT_AVAILABLE") { ... delay = Math.min(24h, 1h * 2^waits) ... }
```

- Une preuve pas encore prête ? On réessaie **patiemment** (1 h, 2 h, 4 h… jusqu'à 24 h), pendant 60 jours maximum. Ensuite, une tâche est ouverte pour un humain.

Tout se retrouve en un seul appel : `GET /api/postal/dispatches/{id}/evidence-bundle`. Il donne chaque preuve, son empreinte, son lien de téléchargement, les approbations (qui et quand) et ce qui manque encore.

---

## 6. Les notifications (webhooks)

```ts
const conn = conns.find((c) => c.webhookTokenHash && safeEqual(c.webhookTokenHash, tokenHash));
if (!conn) return { httpStatus: 404, result: "rejected" };
```

- L'adresse de réception contient un **code secret** propre à chaque connexion. Sans le bon code : « page introuvable ».

```ts
if (known) return { httpStatus: 200, result: "duplicate" };
await enqueue(ctx, d, "RECONCILE", { reason: `webhook:${receipt.eventType}` }, at);
```

- Une notification reçue deux fois est ignorée la seconde fois.
- **On ne croit pas ce qu'elle dit** : elle déclenche seulement une vérification auprès du prestataire. Aucun des deux prestataires ne signe ses notifications, donc un faux message ne peut rien modifier.

---

## 7. P4 : les courriers de santé

Un courrier est classé **santé** dans trois cas (`classifySensitivity`) :
- un patient qui écrit à la CPAM, la MDPH, une mutuelle ou une caisse ;
- une pièce médicale jointe ;
- une variable de santé dans le modèle.

Il est alors **bloqué**, sauf si tout ceci est réuni :

| Condition | Où dans le code |
|---|---|
| Interrupteur `SENSITIVE_POSTAL_ALLOWED=true` | `src/config/flags.ts` |
| Autorisation DPO : DPA + certificat HDS valide du prestataire + liste des pièces et organismes permis | `grantSensitiveAuthorization` |
| NIR saisi à la main par une personne habilitée, vérifié, stocké chiffré à part | `validateSensitiveValues`, `renderValues` |
| Pièce médicale justifiée (« pourquoi indispensable ») | `createDispatch` |
| Enveloppe discrète (pas « Audition… ») | `evaluateCompliance` |
| 3ᵉ approbation « sensible » | `approvalPolicyFor` |
| Lecture réservée à une permission nominative | `requireSensitiveRead` |

### « Faire sauter le verrou » : la bonne façon

Le verrou ne s'enlève pas en modifiant le code. Il s'ouvre **par configuration**, une fois les conditions remplies :

1. Obtenir de Service Postal son certificat HDS (activités couvertes, date de fin) et son DPA signé. Votre hébergement HDS chez OVH ne couvre **pas** leur cloud.
2. Faire valider l'analyse par le DPO.
3. Mettre `SENSITIVE_POSTAL_ALLOWED=true` dans le fichier `.env` du serveur.
4. Le DPO enregistre l'autorisation (`POST /api/postal/sensitive-authorizations`). Il faut un compte avec MFA et la permission `postal.sensitive.authorize`.
5. Donner nominativement les permissions `postal.sensitive.enter`, `postal.sensitive.attach`, `postal.approve_sensitive` et `postal.sensitive.read` aux bonnes personnes.

**Pour essayer tout de suite, sans risque :** en environnement de test (sandbox Service Postal, données fictives), faites les étapes 3 à 5 avec de fausses références. Aucun vrai courrier ne peut partir hors production. Le test `tests/integration/p4.test.ts` fait exactement ce parcours.

---

## 8. Petit lexique

| Mot | Sens |
|---|---|
| API | Une « porte » par laquelle deux logiciels se parlent |
| Webhook | Un message qu'un prestataire nous envoie de lui-même (« le courrier est distribué ») |
| UID | Le numéro du courrier chez Service Postal |
| Outbox / file d'envoi | La liste des tâches à faire par le coursier, gardée en base pour ne rien perdre |
| SHA-256 / empreinte | L'« empreinte digitale » d'un fichier ; prouve qu'il n'a pas changé |
| RLS | Règle de la base de données qui empêche une société de voir les lignes d'une autre |
| Chiffrement AES-256-GCM | Les fichiers sont illisibles sans la clé, et toute altération est détectée |
| Quatre yeux | Celui qui écrit n'est pas celui qui valide |
| Feature flag | Un interrupteur dans la configuration |
| HDS | Hébergement de données de santé : certification obligatoire pour héberger ces données |
| DPA | Contrat de sous-traitance RGPD avec un prestataire |

---

## 9. Lancer les tests

```bash
npm ci
```

```bash
npm test
```

Résultat attendu : `76 passed`. Chaque fichier de `tests/` porte un nom parlant : `recommande.test.ts` (chaîne de preuves), `p4.test.ts` (santé), `manuscry.test.ts` (anniversaires)…
