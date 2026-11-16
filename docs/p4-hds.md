# P4 — Courriers de santé et hébergement HDS

## Ce que fait le code

| Exigence | Mise en œuvre |
|---|---|
| Blocage par défaut | `SENSITIVE_POSTAL_ALLOWED=false`. Tout courrier classé `health` / `personal_sensitive` est bloqué **avant** le moindre appel prestataire. |
| Classification | Est classé santé ou sensible : un patient vers CPAM, MDPH, mutuelle ou caisse ; une pièce médicale (compte rendu, audiogramme, ordonnance, certificat, dossier MDPH) ; une variable de santé ; un NIR. |
| Autorisation documentée | `POST /sensitive-authorizations` (permission `postal.sensitive.authorize`, MFA). Elle porte sur un prestataire, un modèle et une société. Elle exige : la référence de l'analyse DPO, celle du **DPA art. 28**, et la qualification (`hds_certified` : référence, activités couvertes et fin de validité du certificat ; ou `hds_out_of_scope_justified`). Elle liste les catégories de pièces et d'organismes autorisées. Elle est révocable. Jamais vers Manuscry. |
| Contrôle continu | Réévalué avant l'aperçu, à l'approbation et juste avant l'émission. Un certificat expiré, une autorisation révoquée, une pièce ou un organisme hors périmètre : l'envoi est bloqué (`FAILED_VALIDATION`). |
| Saisie des données sensibles | NIR et données de santé **jamais lus dans le dossier**. Ils sont saisis pour le courrier par un utilisateur `postal.sensitive.enter`. Le NIR est vérifié par sa clé de contrôle. Le stockage se fait **dans un actif chiffré**, pas en base : la colonne `merge_values_json` ne les contient pas. |
| Pièces médicales | Permission `postal.sensitive.attach` et **justification obligatoire** (« pourquoi est-elle indispensable »), tracée avec l'auteur. |
| Secret professionnel | Pour un courrier sensible, un nom d'expéditeur discret (`envelopeDisplayName`) est obligatoire. Il ne doit pas évoquer audition, acoustique, optique, vision, prothèse… La référence transmise est opaque (`CORR-…`). |
| Approbation | Étape supplémentaire `sensitive` (permission `postal.approve_sensitive`, quatre yeux), en plus des étapes normales (et des deux étapes LRAR). |
| Lecture | Documents, aperçus, preuves, webhooks, export et dossier de preuves d'un envoi sensible : permission nominative `postal.sensitive.read`. Chaque lecture est journalisée. |
| Conservation | `POST /retention-policies` (permission `postal.retention.manage`) : durée par type d'actif. La purge quotidienne supprime le contenu et conserve le SHA-256. Un envoi en cours n'est jamais purgé. **Sans politique, rien n'est purgé.** |
| Stockage | Disque chiffré (AES-256-GCM) ou stockage objet compatible S3 (`POSTAL_BLOB_BACKEND=s3`), lui aussi chiffré côté application. La signature AWS SigV4 est vérifiée contre botocore. |

Aucune des permissions `postal.sensitive.*`, `postal.approve_sensitive` ou `postal.retention.manage` n'est attribuée par un rôle : elles s'accordent nominativement.

## Ce qui ne relève pas du code (à faire avant d'activer)

1. **Service Postal** : réponse écrite sur sa qualification HDS (certificat et activités couvertes) ou sur une prestation hors champ HDS justifiée, et DPA signé. Ses documents sont stockés dans **son** cloud : votre hébergement HDS ne le couvre pas.
2. **Analyse DPO** : finalités, base légale, information des patients, durées de conservation par type de document.
3. **Organismes** : vérifier que le courrier postal est un canal accepté (`channelPolicy.postalAccepted`). Ne pas présumer qu'il remplace une télétransmission ou un portail.
4. **Recette en sandbox réelle** avec des données fictives, puis activation par société.

## Hébergement chez OVHcloud (HDS)

Le module fonctionne sur une infrastructure standard (PostgreSQL ≥ 14, Node 22, stockage disque ou S3). Points à vérifier avec OVHcloud, à partir de leurs documents contractuels et du certificat, pas de ce dépôt :

- **Éligibilité HDS** de chaque service utilisé : serveurs, base de données, stockage objet, sauvegardes. La région doit aussi être couverte.
- **Contrat HDS** signé.
- **Activités HDS couvertes** par le certificat de l'hébergeur. Si l'administration et l'exploitation que vous assurez vous-même ne sont pas couvertes, vérifier si votre propre certification ou un infogérant certifié est nécessaire.
- **Services annexes** : journaux, supervision, sauvegardes, e-mails, CI. Aucune donnée de santé ne doit en sortir. Les logs du module sont caviardés, mais l'hôte doit garantir le reste.
- Ne pas placer de données patients chez des services non HDS (ex. projets Supabase/Vercel génériques).

Variables pour le stockage objet : `POSTAL_BLOB_BACKEND=s3`, `POSTAL_S3_ENDPOINT`, `POSTAL_S3_REGION`, `POSTAL_S3_BUCKET`, `POSTAL_S3_ACCESS_KEY_ID`, `POSTAL_S3_SECRET_ACCESS_KEY`, `POSTAL_BLOB_KEY`. Le point d'accès et la région sont à reprendre de la console de l'hébergeur. Ce code n'a **pas** été testé contre un compte OVHcloud réel.
