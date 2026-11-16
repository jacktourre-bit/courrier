# API interne `/api/postal`

## Règles communes

| Élément | Règle |
|---|---|
| Authentification | `Authorization: Bearer <JWT>` (HS256 autonome, ou `Authenticator` de l'application hôte) |
| Société active | En-tête **`X-Legal-Entity-Id`** obligatoire. Seules les permissions de cette société s'appliquent. |
| Création d'envoi | En-tête **`Idempotency-Key`** obligatoire (16 à 100 caractères) |
| Corps de requête | Validation Zod stricte : tout champ inconnu donne 422 |
| Traçabilité | `x-request-id` renvoyé ; `cache-control: no-store` |
| Limites | 120 requêtes/min par utilisateur ; corps ≤ 25 Mo ; webhooks ≤ 64 Ko |
| Erreurs | `{ error: { code, message, details }, trace_id }` |

Codes d'erreur : `FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `COMPLIANCE_BLOCKED` (avec `details.blockers[]`), `SENSITIVE_BLOCKED`, `INVALID_TRANSITION`, `CONFLICT`, `BUDGET_EXCEEDED`, `RATE_LIMITED`, `MODULE_DISABLED`.

## Routes

| Méthode | Route | Permission | Effet |
|---|---|---|---|
| GET | `/providers` | postal.read | Connexions, sans secret ni hachage de jeton |
| POST | `/providers` | postal.config.manage + MFA | Crée une connexion. Renvoie **une seule fois** le chemin de webhook. |
| POST | `/providers/{id}/test` | postal.config.manage | Test de la clé (`/entites/lister` ou `/me`) |
| GET/POST | `/templates` | read / templates.manage | Modèles |
| POST | `/templates/{id}/versions` | templates.manage | Nouvelle version. Manuscry : champs lus via l'API. |
| POST | `/template-versions/{id}/approve` | templates.approve (auteur exclu) | Approuve une version et archive la précédente |
| POST | `/templates/{id}/rollback/{versionId}` | templates.approve | Retour arrière |
| POST | `/assets` | postal.draft | Pièce jointe : signature binaire, antivirus, nombre de pages |
| POST | `/dispatches` | postal.draft | Création + conformité + rendu PDF → `READY_FOR_PREVIEW` |
| GET | `/dispatches?status=&page=&per_page=` | postal.read | Liste |
| GET | `/dispatches/{id}` | postal.read | Détail, étapes requises, approbations, événements, preuves attendues et manquantes |
| PATCH | `/dispatches/{id}` | postal.draft | Modification : invalide les approbations, refait le rendu |
| POST | `/dispatches/{id}/preview` | postal.draft | Contrôle de confidentialité puis aperçu et prix chez le prestataire |
| GET | `/dispatches/{id}/quote` | postal.read | HT, TTC, affranchissement, service, pages |
| POST | `/dispatches/{id}/submit` | postal.draft | Entrée dans le circuit d'approbation |
| POST | `/dispatches/{id}/approve` | selon l'étape (approve, approve_legal, approve_sensitive) ; quatre yeux | Étape d'approbation. La dernière met l'envoi en file. |
| POST | `/dispatches/{id}/reject` | postal.approve | Refus motivé |
| POST | `/dispatches/{id}/cancel` | postal.cancel | Annulation locale, ou demande au prestataire |
| POST | `/dispatches/{id}/provider-validation` | postal.approve | Manuscry : valider ou refuser la lettre générée |
| GET | `/dispatches/{id}/document?which=preview` | postal.read (+ evidence.read si sensible) | Téléchargement contrôlé, journalisé |
| GET | `/dispatches/{id}/export` | postal.export | Export sécurisé quand l'envoi externe est interdit |
| GET | `/dispatches/{id}/evidence/{evidenceId}` | postal.evidence.read | Preuve (en-tête `x-sha256`) |
| GET | `/dispatches/{id}/evidence-bundle` | postal.evidence.read | **Dossier de preuves** : document approuvé, aperçu, document imprimé, preuve de dépôt, AR scanné, historique de distribution, webhooks, approbations (SHA-256 et lien de téléchargement pour chacun) |
| GET | `/dispatches/{id}/webhooks/{receiptId}` | postal.evidence.read | Contenu brut d'un webhook reçu (chiffré au repos, en-tête `x-sha256`) |
| GET | `/subjects/{type}/{id}/dispatches` | postal.read | Section « Correspondances » de la fiche |
| POST | `/campaigns` | campaign.manage | Création de campagne |
| GET | `/campaigns` | postal.read | Liste des campagnes |
| POST | `/campaigns/{id}/simulate` | campaign.manage | Simulation, sans appel au prestataire |
| POST | `/campaigns/{id}/approve` | campaign.approve (créateur exclu) | Activation. Anniversaire : `recurrenceOwner` obligatoire. |
| POST | `/preferences` | postal.draft | Accord ou opposition. Une opposition annule les envois en attente et bloque chez Manuscry. |
| POST | `/subjects` | directory.manage | Synchronisation de l'annuaire |
| POST | `/addresses` | directory.manage | Ajout d'adresse |
| GET/POST | `/organizations` | read / organizations.manage | Organismes |
| POST | `/sender-profiles` | config.manage | Profils expéditeur |
| POST | `/budgets` | config.manage | Budgets |
| POST | `/sensitive-authorizations` | **postal.sensitive.authorize** (DPO, MFA) | Autorisation documentée par prestataire, modèle et société |
| POST | `/sensitive-authorizations/{id}/revoke` | postal.sensitive.authorize | Révocation motivée |
| POST | `/retention-policies` | **postal.retention.manage** | Durée de conservation par type d'actif |
| GET | `/tasks` ; POST `/tasks/{id}/close` | read / approve | « À valider » et incidents |
| GET | `/dashboard` | postal.read | Tableau de bord |
| GET | `/audit` | postal.audit.read | Journal d'audit |
| POST | `/webhooks/{manuscry\|servicepostal}/{token}` | jeton secret | Réception. Déclenche une relecture, jamais une mise à jour directe. |

## Rôles par défaut (`src/domain/policy.ts`)

| Rôle | Peut |
|---|---|
| assistante | créer, prévisualiser, soumettre |
| audioprothesiste | + approuver (courrier simple, quatre yeux) |
| manager | + annuler, campagnes, modèles, organismes, annuaire, preuves |
| direction | + approbation juridique (LR/LRAR), dépassement de budget, approbation de modèles et de campagnes, export |
| administrateur | configuration (avec MFA), annuaire, audit |
| audit | lecture, audit, preuves |

Ne sont attribuées par **aucun** rôle et s'accordent nominativement, après validation DPO : `postal.sensitive.authorize`, `postal.approve_sensitive`, `postal.sensitive.enter`, `postal.sensitive.attach`, `postal.sensitive.read`, `postal.retention.manage`.

Courrier sensible (`POST /dispatches`) : `sensitive_values` (ex. `{"patient.nir": "…"}`) et `attachments[].justification` pour chaque pièce médicale.
