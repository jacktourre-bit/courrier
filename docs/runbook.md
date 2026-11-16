# Procédure de reprise sur incident

Principe : **ne jamais renvoyer un courrier à l'aveugle.** Avant toute nouvelle tentative, on vérifie l'état réel chez le prestataire.

## Tableau de bord des incidents

- `GET /api/postal/tasks` : tâches humaines ouvertes (`outbox_submit`, `unknown_submission`, `cancel_refused`, `provider_validation`…).
- `GET /api/postal/dashboard` : envois par statut, preuves manquantes, dépenses.
- Table `postal_outbox` : `status = 'dead'` (tentatives épuisées) ou `'human_task'`.

## Par statut

| Statut | Signification | Action |
|---|---|---|
| `UNKNOWN_SUBMISSION_STATUS` | Timeout ou 5xx **après** émission de la création | Le worker interroge automatiquement le prestataire. Service Postal : `infos.statut = previsualise` prouve que la validation n'a pas eu lieu, l'envoi est resoumis. Manuscry : si le contact n'est pas retrouvé, une tâche `unknown_submission` est ouverte. **Vérifier dans l'interface Manuscry** (recherche par référence `CORR-…`) avant toute action. |
| `FAILED_PROVIDER` | 401 (clé), 403 (campagne Manuscry suspendue), 422 (champs), autre 4xx | Lire `incident`. Corriger la cause (clé, campagne, champ). Ensuite : nouveau courrier, ou repasser en `APPROVED` par un administrateur, avec trace d'audit. |
| `INSUFFICIENT_FUNDS` | Crédits insuffisants chez le prestataire | Recharger le compte, puis relancer. |
| `FAILED_VALIDATION` | Blocage de conformité au dernier moment (opposition, décès, document modifié) | C'est normal : ne pas forcer. Créer un nouveau courrier si l'envoi reste légitime. |
| `CANCEL_REQUESTED` resté longtemps | Le prestataire n'a pas répondu | Le worker réessaie. Un refus remet l'envoi à son statut précédent et ouvre la tâche `cancel_refused`. Service Postal : un numéro d'urgence figure dans sa documentation (endpoint `annuler`). |

## Preuves d'un recommandé

- Les preuves non encore disponibles sont redemandées avec une attente croissante (1 h, puis jusqu'à 24 h), pendant 60 jours au plus, sans abandon prématuré. Ensuite, une tâche humaine est ouverte.
- Le suivi quotidien s'arrête après 21 relectures. Si l'AR ou l'historique manque encore, la tâche `evidence_missing` est ouverte.
- `GET /api/postal/dispatches/{id}/evidence-bundle` montre ce qui est obtenu, ce qui est attendu et ce qui manque.

## Webhooks

- **Jeton compromis** : créer une nouvelle connexion (nouveau jeton), désactiver l'ancienne (`status = 'disabled'`) et reconfigurer l'URL chez le prestataire.
- **Webhooks en panne** : sans conséquence sur l'exactitude. Le worker relit l'état par UID toutes les 24 h, 21 fois au plus. Pour forcer une relecture, insérer une ligne `RECONCILE` dans l'outbox pour l'envoi concerné.
- Un webhook ne modifie jamais un statut directement : il déclenche seulement une relecture via l'API.

## Rotation de clé API

1. Créer la nouvelle clé chez le prestataire.
2. Mettre à jour le secret référencé par `credentials_secret_ref` dans le gestionnaire de secrets.
3. `POST /api/postal/providers/{id}/test`.
4. Révoquer l'ancienne clé.

## Coupure d'urgence

| Besoin | Commande |
|---|---|
| Tout arrêter | `POSTAL_MODULE_ENABLED=false` |
| Un seul prestataire | `MANUSCRY_ENABLED=false` / `SERVICEPOSTAL_ENABLED=false` |
| Automate d'anniversaires | `BIRTHDAY_AUTOMATION_ENABLED=false` |

Les éléments d'outbox restent en file et repartent à la réactivation. **Pas de bascule vers l'autre prestataire.**

## Retour arrière de schéma

```bash
MIGRATION_DATABASE_URL=… npm run migrate -- --down
```

Attention : cette commande supprime l'historique et les preuves. Exporter d'abord si une obligation de conservation s'applique.
