# CAHIER DES CHARGES FONCTIONNEL ET TECHNIQUE
## Module « Courriers & Correspondances » — Intégrations Manuscry et Service Postal

**Version :** 1.0 — 16 novembre 2026  
**Produit :** SaaS métier audioprothèse / optique  
**Statut :** cahier des charges à développer, sans modification de l'application existante  
**Document destiné à :** équipe produit, développeurs, architecte, sécurité, DPO et prestataires.

> **Avertissement :** les fonctionnalités d'API signalées comme documentées ont été confrontées aux documentations publiques consultées le 16/11/2026. Les paramètres détaillés de certains endpoints et garanties contractuelles doivent être confirmés dans la spécification OpenAPI en vigueur. Ce cahier des charges ne constitue ni une validation juridique de l'envoi de données de santé ni un engagement de livraison des prestataires.

## 1. Objet et vision produit

Développer, dans le SaaS existant, un module unique permettant de **créer, personnaliser, prévisualiser, approuver, programmer, envoyer, suivre, archiver et facturer analytiquement des courriers postaux** depuis le dossier patient, une fiche organisme, un dossier administratif ou une campagne.

Le module emploie deux prestataires derrière une interface homogène :

- **Manuscry :** courriers manuscrits personnalisés, cartes d'anniversaire, vœux, remerciements, fidélisation et campagnes événementielles.
- **Service Postal :** lettres formelles PDF/Word, courrier unitaire, publipostage, recommandé avec ou sans AR, annexes, prévisualisation, suivi et récupération de preuves. Service Postal est un **prestataire d'impression/remise au réseau de La Poste**, pas l'API officielle de La Poste.

Le SaaS reste **source de vérité** des données, des préférences, des modèles approuvés, des identifiants métier et de l'historique. Les prestataires n'ont ni accès direct à la base de données patients ni droit de décider à qui envoyer des courriers. Aucune connexion Noah/HIMSA n'est requise.

### Objectifs mesurables

1. Envoyer un courrier depuis la fiche patient en un processus court avec aperçu et contrôle.
2. Programmer les anniversaires et événements autorisés sans doublons ni envoi à un destinataire opposé.
3. Envoyer des lettres formelles aux organismes CPAM, MDPH, mutuelles, fournisseurs et partenaires en conservant les pièces et preuves.
4. Consigner automatiquement les événements postaux dans la chronologie du dossier.
5. Assurer séparation multi-sociétés/multi-centres, autorisations et audit.
6. Prévenir les envois inappropriés, les erreurs d'adresse, les surcoûts et les divulgations de données de santé.

## 2. Périmètre fonctionnel

### 2.1 Usages autorisés à implémenter

| Famille | Exemples | Prestataire cible | Validation |
|---|---|---|---|
| Relationnel | Anniversaire, vœux, remerciement, fidélité, geste de courtoisie | Manuscry | Automatisable uniquement après règles de préférence et validation des modèles |
| Administratif patient | Demande de prise en charge, contestation, transmission de document, dossier MDPH | Service Postal | Humaine obligatoire ; données de santé conditionnées par audit contractuel |
| Administratif société | Banque, assurance, bailleur, mise en demeure, organisme public | Service Postal | Humaine, avec approbation renforcée si LRAR |
| Commercial non médical | Relance partenaire, invitation, parrainage | Manuscry ou Service Postal | Règles de prospection et opposition |
| Lots | Campagne de cartes ou publipostage | Selon type | Simulation du coût et validation du lot |

### 2.2 Hors périmètre initial

- Pas d'envoi automatique de comptes rendus médicaux, audiogrammes, ordonnances, certificats ou pièces MDPH sans contractualisation/sécurité validées.
- Pas de recommandés électroniques qualifiés (LRE) : ils constituent un service distinct.
- Pas de signature électronique qualifiée déduite d'une police manuscrite ; une écriture manuscrite reproduite n'est pas une signature juridique.
- Pas de scraping des portails CPAM/MDPH ni de présomption d'acceptation d'un canal postal par un organisme.
- Pas d'envoi par IA sans approbation, ni d'export complet de fiches patients vers les prestataires.

## 3. Organisation multi-sociétés et multi-centres

Chaque configuration porte `tenant_id`, `legal_entity_id` et, si pertinent, `center_id`. Les sociétés exploitantes et centres conservent leurs identités, coordonnées, entêtes, signatures, adresses de retour, budgets, facturation et autorisations.

L'utilisateur connecté ne voit que les courriers autorisés. Les préférences postales d'un patient et le rattachement à une société ne sont pas propagés entre sociétés par défaut. Une communication émise par une société requiert que l'émetteur soit effectivement autorisé à utiliser les données et à contacter ce destinataire.

**Paramètres par entité :** raison sociale, SIREN/SIRET, nom commercial affiché, adresse retour, logo, téléphone, DPO/contact RGPD, directeur signataire, centres autorisés, prestataires actifs, clés API, quotas et règle d'approbation.

## 4. Interface utilisateur

### 4.1 Barre latérale : « Courriers »

Onglets : **Tableau de bord**, **Nouveau courrier**, **Campagnes**, **À valider**, **Envois et suivis**, **Modèles**, **Organismes**, **Configuration**, **Journal d'audit**.

Le tableau de bord présente les brouillons, prévisualisations, courriers programmés, en cours, distribués, retournés, erreurs, preuves à récupérer et dépenses par centre/société. Les statuts doivent être qualifiés (« envoyé au prestataire », « déposé à La Poste », « distribué ») sans confondre ces étapes.

### 4.2 Depuis la fiche patient

Bouton **« Créer un courrier »** ouvrant un panneau affichant : identité, destinataire/adresse au jour de l'envoi, société émettrice, type d'envoi, modèle, champs autorisés, pièces jointes permises, date, mode d'affranchissement, coût prévisionnel, aperçu et validation.

La fiche patient comporte une section **Correspondances** : type, objet, destinataire, date programmée, date réelle, statut, prestataire, numéro de suivi le cas échéant, contenu final figé, preuve de dépôt/AR si disponible, utilisateur initiateur, utilisateur approbateur et éventuels incidents. L'accès à la pièce doit respecter la sensibilité et les droits du dossier.

### 4.3 Fiches organismes

Répertoire versionné d'organismes : CPAM, MDPH, mutuelles, caisses, bailleurs, fournisseurs, assureurs, partenaires. Champs : nom, service exact, adresse, code postal, pays, domaine, canal officiel recommandé, modalités d'envoi, date et source de vérification, notes internes, rattachement centre, contacts, statut actif/inactif. L'adresse dépend du dossier et de l'organisme compétent ; aucune adresse nationale figée ne doit être supposée.

### 4.4 Éditeur de modèles

- Modèles formels A4 à en-tête avec blocs normalisés (objet, références, destinataire, corps, signature, annexes).
- Modèles manuscrits en cohérence avec les campagnes configurées dans Manuscry ; récupérer les champs par l'API plutôt que coder des variables en dur.
- Variables métier strictement autorisées par modèle, ex. `patient.civilite`, `patient.prenom`, `centre.nom`, `dossier.reference_publique`.
- Aperçu avec faux dossiers de démonstration, vérification du placement de l'adresse, pagination, enveloppe et nombre de feuilles.
- Versionnage, auteur, date d'approbation, statut « brouillon / approuvé / archivé » et procédure de retour arrière.
- Interdiction de rendre un champ médical dans un modèle relationnel ; remplacement par une erreur bloquante, pas par un champ vide silencieux.

## 5. Moteur métier : règles et déclencheurs

### 5.1 Typologie et règles communes

Chaque courrier porte une `purpose` : `transactional`, `administrative`, `relationship`, `marketing`, `legal`. La finalité influe sur les données autorisées, la base légale, l'opposition, le prestataire, la capacité d'automatisation, le modèle et l'approbation.

Avant toute création d'envoi : vérifier existence du destinataire, adresse postale, pays, société émettrice, compatibilité du modèle, absence de désinscription/opposition pertinente, statut du dossier, doublon, budget et habilitation de l'utilisateur. Pour un dossier patient, vérifier en plus l'absence de signal d'exclusion (décès, adresse non valable, contentieux ou opposition, selon données disponibles et finalité).

Conserver un **instantané immuable** de l'adresse, du modèle, de la version, des pièces et de la finalité au moment de l'approbation : une modification ultérieure de la fiche ne doit pas changer un courrier déjà approuvé.

### 5.2 Anniversaires avec Manuscry

1. Détecter chaque jour les dates pertinentes de naissance **uniquement parmi les personnes autorisées** à recevoir une correspondance relationnelle ; l'exploitation de la date de naissance recueillie pour le soin exige une analyse de finalité/base légale.
2. Vérifier date de naissance fiable, adresse récente, centre/société, âge et éventuelle représentation légale ; exclure par défaut les mineurs du programme relationnel automatique sauf règle spécifique validée.
3. Vérifier la campagne Manuscry `birthday`, son état actif et `can_add_contacts` via `GET /api/campaigns/{campaign_id}/settings`.
4. Émettre un enregistrement unique par `person_id + legal_entity_id + birthday + year + campaign_id`. Ne jamais créer deux commandes sur le même événement.
5. Envoyer à Manuscry via son endpoint d'ajout de contact le champ `birthday_date`, l'adresse minimale et un `identifier` opaque. Le prestataire documente une mise à l'envoi **5 jours avant l'anniversaire pour la France et 10 jours pour l'international** ; il ne garantit pas ainsi une réception le jour J. Le SaaS ne doit pas convertir une date de naissance passée ou un événement manqué en envoi immédiat sans règle métier explicite.
6. Éviter de transmettre âge, appareillage, diagnostic, difficultés auditives, couverture sociale ou autres données cliniques dans `ai_context`. Utiliser un message neutre approuvé.
7. Suivre la génération, la demande de validation éventuelle, l'envoi, la distribution et les retours ; répercuter les événements dans la fiche patient.
8. Déterminer contractuellement si Manuscry gère déjà la récurrence annuelle : **un seul acteur** (SaaS ou Manuscry) possède la récurrence, jamais les deux. Prévoir le traitement du 29 février et des nouveaux patients intégrés après la date limite.
9. Permettre le retrait de l'autorisation, l'arrêt des futures occurrences, et traiter le cas d'un contact déjà ajouté chez le prestataire en vérifiant la possibilité de blocage/suppression.

### 5.3 Autres événements automatisables

- Anniversaire de première visite ou de fidélité : seulement si le message est pertinent et non trompeur.
- Remerciement après finalisation d'une prestation : délai configurable, uniquement sans objection et dans la bonne finalité.
- Fêtes et vœux : lot de destinataires approuvés, message neutre.
- Invitations à un événement : campagne classée en prospection ou relationnel selon contenu réel.
- Parrainage : ne pas divulguer le nom du parrain, du filleul ou la relation entre eux sans base appropriée ; envoyer uniquement ce que le destinataire est légitimement censé recevoir.

**Ne pas confondre :** relances commerciales, suivi de soins, rendez-vous et renouvellement d'équipement. Chaque automatisation doit passer par sa propre règle de Compliance, pas par une condition « patient actif » générique.

### 5.4 Courriers administratifs CPAM / MDPH / mutuelles

1. Depuis le dossier, sélectionner l'organisme compétent et le modèle versionné.
2. Générer un document formel (PDF privilégié pour le rendu figé) avec objet, référence et pièces listées.
3. Joindre uniquement les documents indispensables, explicitement sélectionnés par un utilisateur habilité.
4. Évaluer la sensibilité du contenu. **Si pièces ou données de santé et validation contractuelle absente : interdire l'envoi externe et proposer un export sécurisé pour un canal déjà autorisé**.
5. Prévisualiser chez Service Postal uniquement après franchissement du contrôle de confidentialité ; afficher coût, pages, adresse et modalités (simple, suivie, LR ou LRAR).
6. Exiger une approbation humaine, renforcée pour les courriers juridiques, contestations, mises en demeure ou recommandés.
7. Valider l'envoi, associer UID, récupérer le document imprimé définitif, suivre le dépôt et la distribution, récupérer la preuve/AR si disponible.
8. Inscrire chaque étape dans le dossier administratif et la chronologie patient, sans déclarer « reçu par l'organisme » tant qu'une preuve de distribution n'existe pas.
9. Ne pas présumer qu'un envoi postal remplace une télétransmission, une procédure de portail ou un formulaire obligatoire.

## 6. Routage entre prestataires

Le routage s'effectue exclusivement sur serveur :

- `relationship` / `marketing` à rendu manuscrit -> Manuscry, si activité et finalité autorisées.
- `administrative` / `legal` ou besoin d'annexes, de LR/LRAR, de preuve -> Service Postal, sous réserve de conformité.
- Si prestataire indisponible : file d'attente et notification. **Pas de basculement silencieux vers l'autre fournisseur**, car le rendu, les preuves et le contrat diffèrent.
- Si données sensibles : blocage par défaut jusqu'à autorisation spécifique `SENSITIVE_POSTAL_ALLOWED` documentée et validée pour le prestataire, le modèle et l'entité juridique.

## 7. Intégration Manuscry : spécifications vérifiées

**Base :** `https://manuscry.com/api`  
**Authentification recommandée :** `Authorization: Bearer <API_KEY>` conservée côté serveur. La documentation admet aussi une clé en query string, **à proscrire**.  
**Limite documentée :** 100 requêtes/minute/utilisateur ; la prévisualisation partenaire est limitée à 10/minute.  
**Configuration :** clé API, `campaign_id` par finalité/société, mode test contrôlé, choix de validation et catégorie de données autorisées.

| Opération | Endpoint documenté | Usage |
|---|---|---|
| Configuration et champs | `GET /campaigns/{campaign_id}/settings` | Détecter type, statut, champs requis, `can_add_contacts` |
| Ajout à campagne / courrier | `POST /campaigns/{campaign_id}/contacts` | Adresses, `identifier`, variables, `scheduled_at` selon campagne |
| Anniversaire | Même `POST`, campagne `birthday` | `birthday_date` + adresse |
| Statistiques | `GET /campaigns/{campaignId}/stats` | Analytique |
| Courriers | `GET /letters` (vérifier filtres OpenAPI) | Rapprochement et suivi |
| À valider | `GET /letters/to-validate` | File d'approbation |
| Bloquer un destinataire | `DELETE /contacts/{leadId}/block` | Bloquer contact/doublons et annuler les contenus encore en attente |
| Liste de blocage | `GET /blocklist`, `POST /blocklist` | Contrôle des oppositions côté prestataire |
| Validation | `POST /letters/validate/{letterId}` | Approbation ; délai annoncé de 60 min avant validation définitive |
| Refus | `POST /letters/reject/{letterId}` | Refus selon fenêtre opérationnelle |
| Aperçu partenaire | `POST /partners/campaigns/{campaign_id}/preview` | PNG avec watermark, **activation manuelle requise** |
| Événements | Webhooks configurés dans l'interface | Génération, envoi, distribution, retour, QR |

Les données d'adresse documentées comprennent `address_line1`, `address_line2`, `address_line3` (optionnel), `address_zip`, `address_city`, `address_country`. L'envoi manuel peut renseigner `scheduled_at` au format `YYYY-MM-DD`. En campagne anniversaire le champ `birthday_date` est obligatoire. Les variables additionnelles sont obtenues dynamiquement des paramètres de campagne. Ne pas supposer que l'API expose la création de campagnes ou l'édition totale d'un modèle manuscrit : maintenir ces éléments dans Manuscry tant qu'une API correspondante n'est pas contractuellement disponible.

**Point de vigilance :** la réponse à l'ajout de contact n'est pas nécessairement la preuve que la lettre est imprimée ou remise à La Poste. Stocker les étapes distinctes. Ne jamais présumer que `identifier` garantit l'idempotence côté prestataire ; assurer une déduplication locale et réconcilier avant toute nouvelle requête.

Les webhooks documentés comprennent `letter_ready_for_validation`, `letter_sent`, `letter_delivered`, `letter_returned`, `qr_code_scanned`. Les événements de QR sont à désactiver/non exploiter pour les patients sauf finalité et information spécifiques. La documentation publique consultée ne permet pas de confirmer un mécanisme de signature cryptographique des webhooks : obtenir les modalités auprès du fournisseur, appliquer a minima secret d'URL, filtrage, validation du format, horodatage, déduplication et rapprochement via API ; ne pas considérer cela comme une authentification cryptographique équivalente.

## 8. Intégration Service Postal : spécifications vérifiées

**Environnements :**  
- Sandbox : `https://sandbox-api.servicepostal.com`  
- Production : `https://prod-api.servicepostal.com`  
**Authentification :** en-tête HTTP `apiKey: <API_KEY>` selon exemples de documentation.  
**Types d'affranchissement nationaux documentés :** `lrar`, `lr`, `ecopli`, `verte`, `vertesuivi`, `performance`, `perfsuivi` ; contrôler correspondance et disponibilité pour destinations internationales.

### 8.1 Envoi unitaire conseillé : prévisualisation, puis validation

1. Soumettre le document principal et ses éventuelles annexes à l'endpoint de prévisualisation défini dans la version OpenAPI du fournisseur. **Le chemin précis et le schéma intégral de cet endpoint doivent être lus dans l'OpenAPI au moment du développement : ne pas les inventer.**
2. Recevoir l'UID provisoire, les options et l'URL du PDF rendu ; vérifier matériellement l'adresse en fenêtre, le contenu, la pagination et le montant.
3. Interroger si nécessaire `GET /lettres/{uid}/prix` (prix HT séparant affranchissement/service) ; convertir en TTC selon détail fiscal effectif.
4. Après approbation, appeler `POST /lettres/{uid}/valider` avec JSON (`{}` si aucun paramètre facultatif). `date_envoi` peut programmer la date de dépôt et `reference` est limité à 50 caractères ; employer un identifiant opaque non médical.
5. Recevoir le statut de validation, puis récupérer quand disponible : `GET /lettres/{uid}/contenu` pour le document final, `GET /lettres/{uid}/suivi` pour les modes suivis, `GET /lettres/{uid}/preuve_depot` pour les recommandés, `GET /scannedproof/letter/{uid}` pour l'AR scanné si option activée, `GET /lettres/{uid}/infos` pour le rapprochement.
6. En cas d'annulation demandée, utiliser `DELETE /lettres/{uid}/annuler` si encore possible ; confirmer **la réponse effective** avant d'afficher « annulé ». La fenêtre garantie publiée varie selon le mode de courrier et l'heure ; elle n'est pas un droit d'annulation indéfini.

L'envoi immédiat existe mais sera interdit par défaut aux utilisateurs métier pour éviter une expédition avant contrôle du rendu, du prix et des pièces. La documentation indique une remise le jour même pour les lettres unitaires acceptées avant **17 h 30**, mais cela concerne le dépôt dans le réseau et non la réception finale ; ces horaires sont informatifs et doivent être réactualisables.

### 8.2 Publipostage

Supporter un lot contenant modèle principal DOCX/PDF, CSV structuré séparé par point-virgule avec adresses, jusqu'à **20 champs de fusion** d'après la documentation consultée, annexes, option d'affranchissement, simulation du coût, validation puis suivi de chaque pli. Prévoir un test de validation des données avant commande et une visualisation par échantillonnage. La documentation indique un cycle de production du jour pour les publipostages soumis avant **12 h**, sous réserve d'exploitation.

Enregistrer à la fois `batch_id`/UID publipostage et l'UID de chaque lettre individuelle. Ne pas enregistrer un lot comme « livré » tant que les destinataires individuels n'ont pas le statut correspondant.

### 8.3 Prévisualisation et liens cloud

La documentation Service Postal évoque l'hébergement cloud des documents et la fourniture de liens de prévisualisation, de preuve et d'AR. **Ne jamais exposer directement une URL de document sensible dans des logs, emails, outils analytiques ou interfaces publiques**. Préférer un téléchargement contrôlé côté serveur avec conservation sécurisée et droit d'accès, sous réserve de validation des conditions contractuelles, de stockage et de rétention du prestataire.

### 8.4 Webhook Service Postal

La documentation prévoit des webhooks pour étapes de production/distribution. Leur activation demande une prise de contact technique avec le fournisseur (`webmaster@servicepostal.com` selon la documentation). Obtenir format payload, mécanisme de signature, politique de réessai, événements possibles, délais et environnements. Prévoir une consultation de secours ciblée par UID, mais pas un polling massif.

## 9. Architecture cible

```text
[Interface SaaS / Fiche patient / Fiche organisme]
                  |
                  v
      [API métier Courriers / RBAC]
                  |
        [Moteur Compliance]
        - finalité / préférences
        - sensibilité / habilitations
        - quotas / anti-doublons
                  |
        [Modèles + PDF + aperçu]
                  |
      [Circuit d'approbation]
                  |
          [Outbox durable]
                  |
      [File de tâches / workers]
                  |
   [PostalProviderAdapter (interface)]
             /                 \
     [ManuscryAdapter]    [ServicePostalAdapter]
             \                 /
        [Webhooks sécurisés]
                  |
        [Réconciliation états]
                  |
     [Historique / pièces / coûts]
```

**Exigences :** architecture backend uniquement pour secrets, compatibilité avec la stack SaaS existante ; si stack Supabase/PostgreSQL, RLS et Edge Functions ou backend sécurisé, sans considérer qu'une installation générique serait automatiquement conforme HDS. Workers transactionnels avec outbox, file de tâches, dead-letter queue, déduplication. N'utiliser jamais le navigateur comme relais direct des clés API.

Créer une interface TypeScript `PostalProviderAdapter` : `validateConfig`, `getCapabilities`, `createPreview`, `quote`, `submit`, `schedule`, `approve`, `cancel`, `getStatus`, `fetchEvidence`, `handleWebhook`, chaque capacité pouvant retourner `UNSUPPORTED`. Les implémentations ne doivent pas simuler une preuve de distribution indisponible.

## 10. Machine à états et gestion des incidents

États internes normalisés :

`DRAFT` -> `READY_FOR_PREVIEW` -> `PREVIEWED` -> `PENDING_APPROVAL` -> `APPROVED` -> `SCHEDULED` -> `SUBMITTED` -> `IN_PRODUCTION` -> `POSTAL_DEPOSITED` -> `IN_TRANSIT` -> `DELIVERED`

États alternatifs : `REJECTED`, `CANCEL_REQUESTED`, `CANCELLED`, `RETURNED`, `FAILED_VALIDATION`, `FAILED_PROVIDER`, `INSUFFICIENT_FUNDS`, `UNKNOWN_SUBMISSION_STATUS`, `EVIDENCE_PENDING`.

- Les webhooks sont **at-least-once** : traiter un même événement plusieurs fois sans dupliquer le résultat.
- Gérer événements hors ordre par horodatage prestataire, rang métier et règles de transition ; conserver le payload original chiffré ou minimisé selon sensibilité.
- Si timeout survient **après émission du POST** sans réponse, **ne jamais relancer à l'aveugle** : placer en `UNKNOWN_SUBMISSION_STATUS`, rechercher par `identifier`/UID/référence ou support fournisseur, puis décider.
- Retries automatiques seulement sur erreurs dont la non-création de commande est certaine. Pour 4xx définitifs, créer une tâche humaine. Respecter `Retry-After` en cas de 429 si disponible.
- Chaque statut externe conservé avec sa valeur brute, sa traduction et l'heure de dernière synchronisation.

## 11. Modèle de données minimal (PostgreSQL)

**Tables à ajouter, sans duplication des patients :**

- `postal_provider_connections(id, tenant_id, legal_entity_id, provider, environment, credentials_secret_ref, status, last_tested_at, capabilities_json, created_at)`
- `postal_sender_profiles(id, legal_entity_id, center_id, business_name, postal_address_json, contact, signature_asset_id, default_provider, active)`
- `postal_recipient_addresses(id, subject_type, subject_id, address_json, verified_at, verification_source, validity_status, version)`
- `postal_contact_preferences(id, subject_type, subject_id, legal_entity_id, purpose, channel, allowed, legal_basis, evidence_id, updated_at, source)`
- `postal_organizations(id, category, name, branch, service, address_json, channel_policy, verified_at, source, active)`
- `postal_templates(id, legal_entity_id, type, provider, purpose, title, status, current_version_id)`
- `postal_template_versions(id, template_id, version, allowed_merge_fields_json, content_asset_id, approvals_json, content_hash, created_at)`
- `postal_campaigns(id, legal_entity_id, center_id, type, provider, provider_campaign_id, template_version_id, scheduling_rules_json, budget_cents, status)`
- `postal_campaign_recipients(id, campaign_id, subject_type, subject_id, event_key, year, eligibility_snapshot_json, dispatch_id, UNIQUE(campaign_id,event_key,year,subject_id))`
- `postal_dispatches(id, tenant_id, legal_entity_id, center_id, source_type, source_id, subject_type, subject_id, purpose, provider, provider_uid, provider_campaign_id, provider_letter_id, idempotency_key, reference, recipient_snapshot_json, sender_snapshot_json, template_version_id, document_hash, sensitivity, postage_class, scheduled_for, status, quote_ht_cents, quote_ttc_cents, approved_at, approved_by, submitted_at, delivered_at, created_by, created_at)`
- `postal_attachments(id, dispatch_id, asset_id, filename, mime_type, checksum_sha256, sensitivity, page_count, order_index)`
- `postal_events(id, dispatch_id, provider, provider_event_id, event_type, raw_status, occurred_at, received_at, payload_digest, UNIQUE(provider,provider_event_id))` (fallback hash dédupliqué si aucun ID fourni)
- `postal_evidence(id, dispatch_id, kind, secured_asset_id, sha256, obtained_at, source, retention_policy)`
- `postal_approvals(id, dispatch_id, step, approver_user_id, action, reason, timestamp)`
- `postal_outbox(id, dispatch_id, action, payload_digest, status, attempts, next_retry_at, created_at)`
- `postal_audit_logs(id, tenant_id, legal_entity_id, actor_id, action, object_type, object_id, timestamp, metadata_redacted)`.

**Contraintes clés :** UUID/ULID internes ; montant en centimes et devise ; dates en UTC plus fuseau `Europe/Paris` pour l'affichage et la programmation ; champs `patient_id` jamais exposés à un tiers si un alias opaque suffit ; politique de rétention par catégorie et valeur probatoire ; RLS / contrôles explicites backend sur chaque lecture et chaque action ; index `(legal_entity_id,status,scheduled_for)`, `(provider,provider_uid)`, `(subject_type,subject_id)` et contraintes d'unicité pertinentes.

## 12. API interne du SaaS (contrat proposé, non APIs fournisseurs)

```http
GET    /api/postal/providers
POST   /api/postal/providers/{id}/test
GET    /api/postal/templates
POST   /api/postal/templates
POST   /api/postal/dispatches
POST   /api/postal/dispatches/{id}/preview
GET    /api/postal/dispatches/{id}/quote
POST   /api/postal/dispatches/{id}/approve
POST   /api/postal/dispatches/{id}/submit
POST   /api/postal/dispatches/{id}/cancel
GET    /api/postal/dispatches/{id}
GET    /api/postal/subjects/{type}/{id}/dispatches
GET    /api/postal/dispatches/{id}/evidence/{evidenceId}
POST   /api/postal/campaigns
POST   /api/postal/campaigns/{id}/simulate
POST   /api/postal/campaigns/{id}/approve
POST   /api/postal/webhooks/manuscry
POST   /api/postal/webhooks/servicepostal
```

**Règles API :** JSON Schema/Zod strict, RBAC, tenant scoping, CSRF si cookies, trace ID, protection anti-rejeu, limites de débit, validation de MIME/signature de fichier, vérification antivirale, protection SSRF lors du téléchargement des URLs retournées, filtres et pagination, journal d'audit, aucun accès aux pièces sans autorisation.

Objet canonique d'envoi (exemple **interne**, non payload fournisseur) :

```json
{
  "legal_entity_id": "uuid",
  "center_id": "uuid",
  "subject": {"type": "patient", "id": "uuid"},
  "recipient": {"address_id": "uuid"},
  "purpose": "relationship",
  "template_version_id": "uuid",
  "provider": "manuscry",
  "event_key": "birthday:2027",
  "scheduled_for": null,
  "sensitivity": "personal_non_health",
  "approval_policy": "campaign_preapproved",
  "external_reference": "CORR-opaque-id"
}
```

## 13. RGPD, confidentialité, sécurité et HDS : exigences bloquantes

**Séparer impérativement trois choses** : (a) traitement de contact relationnel, (b) traitement administratif contenant des données personnelles, (c) transmission/stockage de données de santé ou documents sensibles. Le fait que le prestataire sache imprimer un PDF ne signifie pas qu'il soit habilité à recevoir n'importe quel document médical.

### 13.1 Privacy by design

- Minimisation stricte des champs transmis : prénom, nom et adresse uniquement lorsque suffisant ; pas de diagnostic, prescription, appareillage ni numéro de sécurité sociale dans les modèles relationnels.
- Enregistrement et vérification de la **finalité**, de la base légale retenue, de l'information fournie à la personne et de ses oppositions ; recueillir une préférence explicite d'anniversaire si choisie comme politique produit, distincte du consentement aux soins.
- Pour la prospection postale : information préalable et moyen d'opposition simple/gratuit, avec liste d'exclusion centralisée **dans la société concernée** et synchronisation pertinente avec le prestataire.
- Attention au **secret professionnel** : un courrier ou l'identité de l'expéditeur peut révéler une relation de soin ; contenu et enveloppe discrets, revue DPO.
- Désactiver par défaut QR de suivi comportemental, géolocalisation de scan et enrichissements d'adresse sur patients.
- Pas de transfert libre de la fiche patient à un modèle d'IA externe : IA seulement sous contrat/paramétrage conforme et sans données de santé non autorisées.

### 13.2 Conditions préalables à l'envoi de santé

Réaliser avec le DPO/consultant juridique une analyse de sous-traitance : DPA/RGPD art. 28, lieux de traitement et de stockage, prestataires ultérieurs, transferts hors EEE, durée de conservation, purge des originaux et backups, accès des opérateurs d'impression, confidentialité et traçabilité, gestion d'incident et droits d'audit. Qualifier au cas par cas si les opérations du tiers constituent de l'hébergement de données de santé relevant du régime HDS ou une prestation transitoire de matérialisation hors champ ; ne **pas présumer** qu'une certification HDS est systématiquement requise pour toute impression ni qu'elle ne l'est jamais. Si la qualification impose HDS, vérifier le certificat **et son périmètre** avant activation.

En attendant ces vérifications : **feature flag désactivé** pour pièces de santé, documents MDPH, audiogrammes, ordonnances, données de handicap, NIR ou autres données sensibles via les deux prestataires.

### 13.3 Contrôles techniques

- API keys dans gestionnaire de secrets ; rotation, accès least privilege, séparation sandbox/production et sociétés.
- Chiffrement TLS côté transport, chiffrement serveur des fichiers, accès par URL courte/signée sur stockage conforme, MFA pour administrateurs.
- Journal d'audit non modifiable par utilisateur standard ; aucun document, token ou données de santé dans les logs de requête.
- Analyse d'intégrité `SHA-256` du PDF validé, de la copie finale réellement imprimée et des preuves ; conservation de versions immuables.
- Webhooks avec authentification adaptée (signature si fournisseur la propose ; sinon compensations et rapprochement vérifié), idempotence et protection contre rejeu.
- Sauvegarde, purge et export des données avec conservation paramétrable selon finalité et obligation réglementaire ; ne pas décréter une durée unique de conservation des pièces juridiques ou médicales.
- Test d'isolement multi-tenant, tests d'injection, détection des envois non autorisés, contrôle fournisseurs et processus d'incident.

## 14. Validation et approbation

### Matrice proposée

| Nature | Émetteur | Approbateur requis | Conditions avant émission |
|---|---|---|---|
| Anniversaire modèle neutre | Automate | Approbation de campagne + règles individuelles | Préférences, finalité, anti-doublon, budget |
| Remerciement ponctuel | Agent habilité | Agent ou responsable selon politique | Aperçu et contrôle des coordonnées |
| Lettre administrative | Agent | Responsable de centre / utilisateur habilité | Pièces, destinataire, conformité |
| LRAR / contestation / contentieux | Agent | Manager ou direction habilitée | Relecture finale obligatoire, preuve attendue |
| Courrier avec données de santé | Personne habilitée | Approbation renforcée après conformité vérifiée | Autorisation spécifique + minimisation + canaux acceptés |
| Publipostage | Responsable | Direction selon seuil | Simulation, échantillon, budget, exclusions |

La validation doit conserver utilisateur, date, version du contenu, pièces et prix. Une modification de contenu ou d'adresse **invalide l'approbation précédente**.

## 15. Budget, facturation et tableaux de bord

- Définir budget mensuel et plafonds par société/centre/campagne ; seuils d'alerte 50 %, 80 %, 100 % configurables.
- Afficher devis fournisseur avant validation et détail : affranchissement, impression/service, options, TVA, coût estimé, coût réel et écarts.
- Bloquer les campagnes dépassant la limite sans approbation exceptionnelle.
- Importer facture ou relevé mensuel des prestataires pour rapprochement comptable **sans inventer d'écritures comptables automatiques** ; mapping de charges et TVA à faire valider par expert-comptable.
- KPI : nombre soumis, déposé, distribué, retourné, coût par pli, coût par centre, délai de production, délai de distribution observé, taux d'erreur, frais de retour, courriers sans preuve attendue et taux de désinscription.
- Ne pas mesurer « ouverture » d'un courrier simple comme s'il existait une preuve de lecture.

## 16. Tests de recette obligatoires

**Parcours métiers**
1. Créer un anniversaire pour un patient autorisé et générer un seul événement annuel.
2. Refuser l'envoi si opposition ou finalité non autorisée.
3. Bloquer un mineur sans politique adaptée et un dossier marqué décédé.
4. Vérifier 29 février, changement d'adresse et anniversaire déjà passé.
5. Ne pas injecter de données médicales dans `ai_context`.
6. Afficher l'aperçu Manuscry uniquement si accès partenaire activé ; sinon parcours alternatif clair.
7. Prévisualiser courrier Service Postal, vérifier coût puis envoyer après approbation.
8. Envoyer une LRAR non médicale avec annexe et récupérer preuve/AR.
9. Vérifier que la version PDF imprimée est archivée, avec hachage.
10. Gérer un lot avec 20 champs maximum et rapports individuels.
11. Bloquer un organisme sans adresse ou avec adresse non vérifiée selon politique.
12. Révoquer l'approbation si le document change.

**Fiabilité/API**
13. Traiter un webhook en double sans double événement.
14. Traiter des webhooks reçus hors ordre sans régression de statut.
15. Simuler un timeout après POST et vérifier absence de double commande.
16. Gérer 401 (clé), 403 (campagne suspendue), 422 (champ), 429 (limite), 5xx (incident), crédits insuffisants.
17. Tester sandbox/prod et les clés de sociétés séparées.
18. Vérifier l'annulation dans et hors fenêtre documentée.
19. Rejouer réconciliation et import de preuve après interruption réseau.
20. S'assurer qu'un webhook forgé ne modifie pas arbitrairement un dossier.

**Sécurité/conformité**
21. Tenter accès à un courrier d'une autre société : refus systématique.
22. Tenter envoi de donnée de santé lorsque le feature flag est désactivé : blocage complet avant API fournisseur.
23. Vérifier qu'aucun secret ou PDF ne se retrouve dans logs, analytics ou erreurs.
24. Vérifier purge et restriction des liens de prévisualisation/preuves.
25. Tester profils utilisateur : assistante, audioprothésiste, manager, administrateur, direction et audit.
26. Prouver par audit qui a créé, relu, approuvé et déclenché un LRAR.
27. Tester exactement les champs dynamique récupérés de Manuscry.
28. Vérifier l'écart de fuseau et les échéances en jours ouvrés/jours fériés.

**Critère d'acceptation global :** aucun envoi non autorisé ni double envoi ; réconciliation vérifiable avec chaque prestataire ; preuve et document final présents quand l'offre fournit ces objets ; séparation des sociétés démontrée ; conformité avant activation des courriers sensibles.

## 17. Découpage de réalisation et priorités

**P0 — Fondations et sécurité** : modèle de données, architecture adaptateurs, rôles, journaux, modèles, validateur d'adresse, règles de préférences, classification sensibilité, secrets, configuration multi-entités, outbox et feature flags.

**P1 — Service Postal administratif non médical** : composition, pièces non médicales, PDF, prévisualisation, prix, double validation, envoi, suivi, preuves, annulation et historique.

**P2 — Manuscry relationnel** : connexion API, sélection de campagne, chargement des champs, test d'envoi neutre, anniversaires et préférences, suivi, webhooks, quotas.

**P3 — Campagnes, reporting et IA contrôlée** : publipostage, budgets, tableaux de bord, suggestions de rédaction avec confirmation humaine, segmentation sans données sensibles, bibliothèque d'organismes.

**P4 — Courriers de santé et dossiers MDPH/CPAM** : **seulement après** audit juridique, contractuel, sécurité, qualification HDS applicable et recette dédiée. Maintenir la voie export/canal autorisé si non validé.

## 18. Questions bloquantes à envoyer aux fournisseurs

### À Manuscry

1. Un contact d'anniversaire reste-t-il dans une campagne et déclenche-t-il un envoi chaque année, ou l'application doit-elle réinscrire les contacts ?
2. Comment mettre à jour/supprimer un contact d'anniversaire ou stopper les envois futurs après opposition ?
3. Quelle unicité/idempotence garantit le champ `identifier` en cas de POST répété ?
4. Peut-on obtenir les rendus finaux et l'historique des preuves ? Quelles limites de suivi réel ?
5. Comment activer le endpoint de preview partenaire ? Peut-on désactiver QR et tracking enrichi ?
6. Webhooks : signature, secret, retries, durée de conservation et liste contractuelle d'événements ?
7. DPA, lieux d'hébergement, sous-traitants, rétention, suppression, usage des données pour IA et interdiction de réutilisation ?
8. Existe-t-il un environnement sandbox complet et une gestion des clés par société ?

### À Service Postal

1. Fournir l'OpenAPI/Swagger 1.7.0 téléchargeable et les payloads exacts preview/envoi/publipostage.
2. Confirmer les champs obligatoires, schémas de documents, poids/pages, limites et formats.
3. Webhooks : configuration, signature/authentification, retries, déduplication, statut des preuves et AR.
4. Conditions de stockage des PDF, annexes, scans, preuves et URLs Cloud ; durée, purge et sous-traitants.
5. Contrat de sous-traitance RGPD, accès des opérateurs, contrôle des impressions, confidentialité des enveloppes et incidents.
6. Qualification des traitements de santé et HDS si applicable ; certificats/périmètres ou mesures contractuelles alternatives légalement suffisantes.
7. Confirmation du caractère probant et des limites de chaque preuve de dépôt et de distribution.
8. Tarifs entreprise, règles d'annulation, jours fériés, hors France et horaires en vigueur ; coûts pour AR scanné.
9. Possibilité d'une clé distincte par société, centre ou sous-compte et modalités de facturation.

## 19. Consigne de développement pour Claude / Codex

1. **Commencer par un audit de l'application existante** : framework, modèles patients, sociétés/centres, permissions, moteur Compliance, stockage de documents, événements et journaux.
2. **Ne pas modifier d'autres modules** sans nécessité explicitement justifiée. Proposer migration réversible et mécanisme de désactivation.
3. **Implémenter d'abord les fondations**, schémas et adaptateurs simulés ; tests d'intégration en sandbox avec données fictives exclusivement.
4. **Ne pas créer d'API fournisseurs supposées** : lire les spécifications à jour, signer les contrats, valider les capacités.
5. **Prévoir des feature flags** : `POSTAL_MODULE_ENABLED`, `MANUSCRY_ENABLED`, `SERVICEPOSTAL_ENABLED`, `BIRTHDAY_AUTOMATION_ENABLED`, `SENSITIVE_POSTAL_ALLOWED` (désactivé par défaut), `POSTAL_BATCH_ENABLED`.
6. **Ne jamais déclencher d'envoi réel automatiquement en environnement de développement** ; sandbox et mocks obligatoires.
7. Livrer migrations, code typé, tests automatisés, API interne documentée, journal d'audit, interface, documentation de configuration et procédure de reprise sur incident.
8. Présenter un tableau « documenté / confirmé par test / à confirmer contractuellement » pour chaque capacité d'API ; tout élément non validé reste inaccessible en production.

## 20. Références consultées

- Documentation Manuscry v1.0 : https://manuscry.com/api-docs
- Documentation Service Postal API v1.7.0 : https://docs.servicepostal.com/
- Présentation API Service Postal : https://api.servicepostal.com/
- CNIL, prospection par courrier postal (10 juin 2026) : https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-postal
- ANS, champ d'application HDS : https://esante.gouv.fr/faq/quel-est-le-champ-dapplication-de-la-legislation-relative-lhebergement-de-donnees-de-sante-caractere-personnel
- Service-public, recommandé électronique (distinct du LRAR papier) : https://www.service-public.gouv.fr/particuliers/vosdroits/F31463

**Décision d'architecture retenue :** une interface unifiée, deux adaptateurs séparés, une source de vérité interne, des opérations contrôlées et auditables, et une interdiction technique d'exposer des données de santé aux prestataires tant que la conformité de cet usage n'a pas été démontrée.
