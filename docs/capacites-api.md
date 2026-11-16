# Capacités prestataires — documenté / testé / à confirmer

Exigence §19.8 du cahier des charges. Sources lues le **16/11/2026** :

- Service Postal : OpenAPI **1.7.0** (`https://docs.servicepostal.com/sp-doc-v3.json`, servie par la page Redoc).
- Manuscry : `https://manuscry.com/api-docs` et `https://manuscry.com/openapi/api-manuscry-v1.yaml`.

Légende de la colonne « Test » :

- **Simulateur** : couvert par les tests automatisés contre un faux serveur qui reproduit le contrat documenté (`tests/fakes.ts`). Cela prouve que **notre code** respecte la doc. Cela ne prouve pas que **le prestataire** se comporte comme sa doc.
- **Sandbox réelle** : non réalisé. Aucune clé n'était disponible. C'est à faire avant toute mise en production.

Règle : tout ce qui n'est pas « documenté » ou « testé en sandbox réelle » reste inaccessible en production. Le flag `POSTAL_PRODUCTION_PROVIDERS_ALLOWED` est faux par défaut et forcé à faux hors `NODE_ENV=production`.

## Service Postal

| Capacité | Endpoint | Doc | Test | À confirmer |
|---|---|---|---|---|
| Authentification | en-tête `apiKey` | ✅ | Simulateur | Une clé par société / sous-compte ? |
| Prévisualisation | `POST /lettres/previsualiser` (mêmes champs que `POST /lettres`) | ✅ | Simulateur | Durée de validité d'un UID prévisualisé non validé |
| Prix | `GET /lettres/{uid}/prix` (+ prix dans la réponse de prévisualisation) | ✅ HT ; TVA 20 % sur le service seulement | Simulateur | Tarifs entreprise / abonnement |
| Validation | `POST /lettres/{uid}/valider` `{reference ≤ 50, date_envoi?}` | ✅ | Simulateur | Comportement d'une double validation du même UID |
| Envoi immédiat | `POST /lettres` | ✅ | **Volontairement non utilisé** | — |
| Annulation | `DELETE /lettres/{uid}/annuler` | ✅ 15 min (non suivi) / 30 min (suivi) avant 15h30, sinon tant que rien n'est imprimé | Simulateur (dans / hors fenêtre) | Codes de réponse exacts d'un refus |
| Infos | `GET /lettres/{uid}/infos` → `statut` ∈ previsualise, valide, annule, imprime, depose | ✅ | Simulateur | — |
| Suivi | `GET /lettres/{uid}/suivi` → `code_statut` (soumis, courrier_produit, pris_en_charge, attente_retrait_guichet, distribue_destinataire[_en_lot], distribue_expediteur, retour_expediteur, ar_scanne) | ✅ (LR, LRAR, verte suivie, performance suivie) | Simulateur | Fuseau des `date_statut` |
| Document final | `GET /lettres/{uid}/contenu` (base64) | ✅ | Simulateur | Délai de disponibilité |
| Preuve de dépôt | `GET /lettres/{uid}/preuve_depot` → URL | ✅ (recommandés) | Simulateur | **Domaines d'hébergement** des URL (liste blanche SSRF à renseigner) |
| AR scanné | `GET /scannedproof/letter/{uid}` (option `ar_scan`, LRAR) — **activée par défaut** sur toute LRAR | ✅ | Simulateur (AR arrivant à J+10) | Coût de l'option ; délai réel de numérisation |
| Historique de distribution | réponse complète de `/suivi` archivée (JSON haché) à la distribution ou au retour | ✅ | Simulateur | Valeur probante de cet historique (cahier Q7) |
| Adresses | 2 lignes de 38 car. max, civilités imposées, pays en toutes lettres (FR) | ✅ | Simulateur + unitaires | Liste complète des pays (11 mappés) |
| Webhooks | « service Webhook » mentionné, activation par contact technique | ⚠️ format non publié | Simulateur (extraction d'UID générique) | **Format, signature, retries, événements** |
| Publipostage | `/publipostages/*` (checkcsv, prix, soumettre, valider, annuler, statut…) | ✅ | ❌ non implémenté (P3) | Limite de 20 champs de fusion (non trouvée dans l'OpenAPI) |
| Vérification d'adresse IA | `POST /iapostale` | ✅ (payant en production) | ❌ non branché | Usage sur des patients à valider DPO |

## Manuscry

| Capacité | Endpoint | Doc | Test | À confirmer |
|---|---|---|---|---|
| Authentification | `Authorization: Bearer` (la variante `?api_key=` est proscrite) | ✅ | Simulateur | Clés par société |
| Paramètres de campagne | `GET /campaigns/{id}/settings` → `campaign{type,status,can_add_contacts}`, `fields[]` | ✅ | Simulateur | — |
| Ajout de contact | `POST /campaigns/{id}/contacts` (un objet ; nom dans `address_line1`, rue dans `address_line2`) | ✅ | Simulateur | **Idempotence de `identifier`** (cahier Q3) |
| Réponse à l'ajout | `data.contact.identifier` — **ni id de lettre ni id de lead** | ✅ | Simulateur | — |
| `scheduled_at` | une date **passée part immédiatement** | ✅ | Unitaire (refus d'une date non future) | — |
| Anniversaire | `birthday_date` YYYY-MM-DD ; envoi J-5 (FR) / J-10 (international) | ✅ | Simulateur | **Récurrence annuelle** (cahier Q1) ; acceptation d'une date d'occurrence au lieu de la date de naissance |
| Lettres | `GET /letters?lead_identifier=` ; statuts validating, generating, printing, sending, transiting, delivered, returned, cancelled, error | ✅ | Simulateur | Sens exact de `sending` (mappé à « déposé ») |
| Recherche de contact | `GET /contacts?search=` | ✅ | Simulateur | **La recherche couvre-t-elle `identifier` ?** (sert au rapprochement après timeout) |
| Validation / refus | `POST /letters/validate|reject/{letterId}`, délai de 60 min | ✅ | Simulateur | — |
| Blocage | `DELETE /contacts/{leadId}/block` | ✅ | Simulateur | Effet sur les occurrences futures d'anniversaire |
| Aperçu partenaire | `POST /partners/campaigns/{id}/preview` (PNG filigrané, 10/min) | ✅ activation manuelle | Simulateur (parcours alternatif) | Activation du compte |
| Webhooks | `letter_ready_for_validation`, `letter_sent`, `letter_delivered`, `letter_returned`, `qr_code_scanned`, `new_calendar_event` | ✅ configuration dans l'interface | Simulateur | **Pas d'id d'événement, pas de signature, pas de politique de retry** |
| Prix | — | ❌ aucun endpoint | — | Coût unitaire contractuel (`unitCostTtcCents` en paramètre) |
| Crédits insuffisants | catégorie `insufficient_funds` côté lettres ; 402 documenté seulement pour la recherche d'adresse | ⚠️ | Simulateur (402 générique) | Erreur renvoyée à l'ajout de contact |
| Sandbox | — | ❌ non documentée | — | **Bloquant** : les écritures Manuscry sont refusées hors production |
| Preuves | — | ❌ | — | — |

## Écarts assumés par rapport au cahier des charges

| Point du cahier | Choix retenu | Raison |
|---|---|---|
| §8.1 « endpoint de prévisualisation à lire dans l'OpenAPI » | `POST /lettres/previsualiser` | Lu dans l'OpenAPI 1.7.0 |
| §10 `EVIDENCE_PENDING` | Indicateur dérivé (`evidence_missing`), pas une étape du cycle de vie | Ne pas masquer le statut `DELIVERED` |
| §12 `POST /dispatches/{id}/submit` | Entrée dans le circuit d'approbation ; l'émission vers le prestataire part automatiquement de l'outbox après l'approbation finale | Une seule voie d'émission, toujours contrôlée |
| §5.2.5 `birthday_date` | Par défaut, date de la **prochaine occurrence** (pas l'année de naissance) | Minimisation : l'âge n'est pas transmis. Option `birth_date` disponible |
| §5.4 courrier patient → CPAM/MDPH/mutuelle | Classé `health` d'office, donc bloqué tant que P4 n'est pas validé | Le courrier lui-même révèle une relation de soin |
