# Module « Courriers & Correspondances »

> Débutant ? Lisez d'abord [`docs/guide-debutant.md`](docs/guide-debutant.md) : le parcours d'un recommandé expliqué pas à pas, extraits de code à l'appui. Dans le code, cherchez `EN CLAIR`.

Ce module crée, prévisualise, approuve, programme, envoie, suit et archive des courriers postaux, derrière une interface unique :

- **Service Postal** pour les courriers formels PDF : simple, suivi, LR, LRAR, annexes, preuves.
- **Manuscry** pour les courriers manuscrits relationnels : anniversaires, remerciements.

Le SaaS reste la source de vérité. Les prestataires ne reçoivent que le minimum : adresse, prénom et une référence opaque `CORR-…`. Ils ne reçoivent jamais l'identifiant patient. Le cahier des charges complet est dans [`docs/cahier-des-charges.md`](docs/cahier-des-charges.md).

## État d'avancement (phases du cahier §17)

| Phase | Statut |
|---|---|
| **P0** Fondations | ✅ Modèle de données et migration réversible, RLS forcée, adaptateurs, rôles, audit immuable, modèles versionnés, validateur d'adresse, préférences et oppositions, classification de sensibilité, secrets référencés, multi-sociétés, outbox, feature flags |
| **P1** Service Postal administratif non médical | ✅ Rendu PDF, pièces jointes, prévisualisation, prix, double validation, envoi, suivi, preuves, annulation |
| **P2** Manuscry relationnel | ✅ Champs de campagne lus via l'API, anniversaires (29 février, délais J-5/J-10, anti-doublon), suivi, webhooks, blocage sur opposition |
| **P3** Publipostage, tableaux de bord avancés, IA | ⏳ Non fait. Budgets et tableau de bord de base présents. |
| **P4** Courriers de santé (CPAM/MDPH…) | ✅ Code livré, **désactivé par défaut**. Autorisation DPA/HDS par prestataire, modèle et société ; saisie NIR chiffrée ; pièces justifiées ; enveloppe discrète ; approbation dédiée ; lecture nominative ; purge de conservation. Activation après audits : [`docs/p4-hds.md`](docs/p4-hds.md). |
| Interface utilisateur | ⏳ Non faite. L'API interne est prête à être consommée ([`docs/api-interne.md`](docs/api-interne.md)). |

## Architecture

```text
API interne (Hono, Zod strict, RBAC par société, idempotence)
  └─ services : dispatch (création → rendu → aperçu → approbation) · compliance · budget · campagnes · préférences
       └─ outbox durable ─► worker (SUBMIT, RECONCILE, FETCH_EVIDENCE, CANCEL, PROVIDER_VALIDATE, PROVIDER_BLOCK)
            └─ PostalProviderAdapter ─► ServicePostalAdapter | ManuscryAdapter
webhooks (jeton secret) ─► déduplication ─► relecture via l'API (jamais de statut lu dans le payload)
stockage : PostgreSQL (RLS) + blobs chiffrés AES-256-GCM
```

Stockage : disque chiffré ou stockage objet compatible S3 (OVHcloud Object Storage), chiffrement côté application dans les deux cas.

| Dossier | Contenu |
|---|---|
| `src/domain` | Types, machine à états, adresses, variables de fusion, sensibilité, routage, matrice d'approbation, rôles |
| `src/providers` | Adaptateurs prestataires, client HTTP qui classe les échecs (RETRYABLE / UNKNOWN / DEFINITIVE…) |
| `src/services` | Logique métier, worker, webhooks, automate d'anniversaires |
| `src/store` | Accès aux données (mémoire et PostgreSQL), blobs chiffrés |
| `src/api` | API HTTP, authentification |
| `db/migrations` | SQL `up` / `down` |

## Garanties principales

| Garantie | Comment |
|---|---|
| Pas de double envoi | Clé d'idempotence ; marqueur posé avant l'appel ; un timeout après émission donne `UNKNOWN_SUBMISSION_STATUS` puis un rapprochement, jamais un renvoi ; index unique par événement ; unicité `campagne + événement + année + personne` |
| Pas d'envoi non autorisé | Conformité réévaluée à la création, à l'aperçu, à l'approbation **et** juste avant l'émission. Couvre : opposition, décès, mineur, contentieux, adresse, modèle approuvé, société. |
| Approbation liée au contenu | Hachage du document, de l'adresse, des pièces, du prix et des options. Toute modification invalide l'approbation. Quatre yeux pour l'administratif ; deux étapes pour LR/LRAR et le juridique. |
| Données de santé | Classification conservatrice : un patient écrivant à la CPAM, MDPH, une mutuelle ou une caisse est classé `health`, comme les pièces médicales ou les termes santé dans un texte relationnel. Blocage complet **avant** tout appel prestataire. |
| Isolement multi-sociétés | Filtre applicatif + RLS PostgreSQL forcée (testée avec un rôle sans BYPASSRLS) |
| Secrets | Seules des références (`env:` / `vault:`) sont stockées. Les logs caviardent clés, adresses, documents et URL. |
| Développement | Les connexions `production` sont impossibles hors `NODE_ENV=production`. Manuscry n'a pas de sandbox : ses écritures sont refusées hors production. |

## Démarrage

```bash
npm ci
```

```bash
npm test
```

```bash
cp .env.example .env
```

Renseigner ensuite `DATABASE_URL`, `POSTAL_BLOB_KEY` et `POSTAL_JWT_SECRET`.

```bash
MIGRATION_DATABASE_URL=postgres://owner@… POSTAL_APP_ROLE=postal_app npm run migrate
```

```bash
npm run dev
```

```bash
npm run worker
```

Le worker traite l'outbox toutes les 15 s et lance l'automate d'anniversaires une fois par jour.

Tests PostgreSQL (RLS, triggers, contraintes, concurrence) :

```bash
POSTAL_TEST_PG=1 PG_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postal_test PG_APP_URL=postgres://postal_app:postal_app@127.0.0.1:55432/postal_test npm run test:pg
```

## Intégration dans une application hôte

1. **Annuaire** : remplacer la table `postal_subjects` par une vue sur le référentiel patients/contacts (mêmes colonnes), ou la synchroniser via `POST /subjects`.
2. **Authentification** : fournir un `Authenticator` (`src/api/auth.ts`) qui mappe l'utilisateur vers ses sociétés et ses rôles.
3. **Stockage** : remplacer `EncryptedFsBlobStore` par le stockage conforme de l'hôte. Brancher un `MalwareScanner` : sans antivirus, les dépôts de fichiers sont refusés en production.
4. **Secrets** : implémenter `SecretStore` sur le gestionnaire de secrets (rotation, moindre privilège).

## Avant toute mise en production

- [ ] Tests en **sandbox Service Postal réelle** et activation des webhooks auprès du fournisseur (format, signature).
- [ ] Réponses de Manuscry : récurrence annuelle, idempotence de `identifier`, recherche de contact par `identifier`, environnement de test, DPA. Voir [`docs/capacites-api.md`](docs/capacites-api.md).
- [ ] Liste blanche des domaines d'hébergement des documents Service Postal (`documentHostSuffixes`).
- [ ] Analyse DPO : finalités, base légale, information, conservation (`retention_policy` vaut aujourd'hui `to_define_by_dpo`), qualification HDS.
- [ ] Antivirus, gestionnaire de secrets, MFA côté hôte, limiteur de débit partagé si plusieurs instances.

Incidents : [`docs/runbook.md`](docs/runbook.md).
