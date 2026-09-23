# Infra — VPS partagé (TLPosta + cherryfruitz, + prochain projet)

**Self-hosted**, sur un seul VPS qui héberge plusieurs produits indépendants du même propriétaire. **TLPosta** (`igposta.service`) et **cherryfruitz** (`cherryfruitz.service`) y tournent déjà, tous deux déployés et vérifiés en production (voir §3). Ce document est la référence à donner à toute nouvelle session Claude qui doit ajouter un projet sur ce même VPS : il doit permettre de déployer **sans jamais toucher à ce qui existe déjà** (ni TLPosta, ni cherryfruitz).

## 1. Accès

- Hôte : `95.111.242.100`
- Utilisateur : `root`
- Clé SSH : `~/.ssh/igposta_vps_ed25519` (déjà présente sur cette machine, réutilisable telle quelle)
- Connexion : `ssh -i ~/.ssh/igposta_vps_ed25519 root@95.111.242.100`
- La connexion SSH vers ce VPS est parfois instable (timeouts intermittents, sans rapport avec le VPS lui-même) — en cas de timeout, réessayer 2-3 fois avant de conclure à un vrai problème.

## 2. Ressources disponibles (mesurées le 2026-09-18, avant l'arrivée de cherryfruitz)

- CPU : 6 vCPU (AMD EPYC, ~2.0GHz), charge quasi nulle (`load average` < 0.1)
- RAM : 11 Go au total, **~10 Go libres** (TLPosta n'en utilise que ~240 Mo en fonctionnement normal, pic ponctuel à ~2.8 Go pendant un rendu vidéo lourd)
- Disque : 193 Go au total, **~177 Go libres**
- Node.js déjà installé : v20.20.2 (npm 10.8.2) — réutilisable directement, pas besoin de le réinstaller
- Pas de PM2 installé — chaque projet tourne via son propre service `systemd` natif (TLPosta = `igposta.service`, cherryfruitz = `cherryfruitz.service`), même convention à reprendre pour tout nouveau projet plutôt que d'introduire un nouvel outil de process management

cherryfruitz (Next.js + SQLite) ajoute une empreinte modeste par-dessus TLPosta. Il reste largement de la marge pour un troisième service Node sur ce VPS — revérifier `free -h` / `df -h` avant de committer un projet plus lourd (vidéo, gros stockage de fichiers, etc.).

## 3. Ce qui existe déjà sur ce VPS — À NE JAMAIS TOUCHER

### TLPosta (`igposta`)

| Élément | Valeur | Règle |
|---|---|---|
| Répertoire app | `/opt/igposta` | Ne jamais lire/écrire dedans, ne jamais y déployer quoi que ce soit d'un autre projet |
| Service systemd | `igposta.service` | Ne jamais l'arrêter, le redémarrer, le modifier, ni écrire un service qui porte un nom proche |
| Port interne | `3000` (`127.0.0.1:3000`) | Ne jamais le réutiliser |
| Base de données | `/opt/igposta/database.json` (fichier JSON plat) | Ne jamais y toucher |
| Config nginx | `/etc/nginx/sites-enabled/igposta` (domaines `tlposta.com`/`www.tlposta.com`) | Ne jamais modifier ce fichier — seulement AJOUTER un nouveau fichier de config à côté |
| Certificat SSL | `/etc/letsencrypt/live/tlposta.com/` (Certbot) | Ne jamais y toucher, ne jamais `--expand` dessus pour y ajouter un sous-domaine — demander un certificat **séparé** pour tout nouveau domaine/sous-domaine (voir §5) |

### cherryfruitz

| Élément | Valeur | Règle |
|---|---|---|
| Répertoire app | `/opt/cherryfruitz` | Ne jamais y déployer un autre projet |
| Service systemd | `cherryfruitz.service` | Ne jamais l'arrêter/redémarrer/modifier depuis un autre projet |
| Port interne | `3001` (`127.0.0.1:3001`) | Ne jamais le réutiliser |
| Base de données | `/opt/cherryfruitz/data/cherryfruitz.sqlite` (SQLite) | Ne jamais y toucher |
| Config nginx | `/etc/nginx/sites-enabled/cherryfruitz` (domaines `cherryfruitz.com`/`www.cherryfruitz.com`) | Ne jamais modifier ce fichier |
| Certificat SSL | `/etc/letsencrypt/live/cherryfruitz.com/` (Certbot) | Ne jamais y toucher |

**Principe général, valable pour tout nouveau projet sur ce VPS : installation 100% indépendante — son propre dossier sous `/opt/`, son propre service systemd (nom distinct), son propre port interne (vérifier `ss -tlnp` avant de le fixer — `3000` et `3001` sont déjà pris), sa propre base de données, son propre fichier de config nginx, son propre certificat SSL.** Aucun fichier ni processus partagé entre projets. Un crash, un redéploiement ou un pic de charge sur l'un ne doit jamais pouvoir affecter les autres.

## 4. cherryfruitz — DÉJÀ DÉPLOYÉ ET EN PROD (rien à créer ici, historique/référence seulement)

**Tout ce qui suit existe déjà et tourne.** Cette section documente l'état réel pour que la §5 (prochain projet) ait un exemple concret à imiter — ce n'est **pas** une liste d'étapes à exécuter. La source de vérité pour un redéploiement de cherryfruitz est `deploy/RUNBOOK.md` + `deploy/cherryfruitz.service` + `deploy/nginx-cherryfruitz.conf` dans le repo cherryfruitz, pas ce fichier.

- Répertoire app : `/opt/cherryfruitz` (déployé par `rsync` depuis le repo local, voir `deploy/RUNBOOK.md`)
- Port interne : `3001`
- Base de données : **SQLite**, fichier `/opt/cherryfruitz/data/cherryfruitz.sqlite`
- Domaine : `cherryfruitz.com` / `www.cherryfruitz.com`, DNS déjà en place chez le registrar

### Service systemd — déjà créé et actif : `cherryfruitz.service`

Contenu réel (`deploy/cherryfruitz.service` dans le repo, copié en `/etc/systemd/system/cherryfruitz.service` sur le VPS) :

```ini
[Unit]
Description=Cherryfruitz application server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/cherryfruitz
ExecStart=/usr/bin/node /opt/cherryfruitz/node_modules/.bin/next start -p 3001
Restart=always
RestartSec=5
User=root
EnvironmentFile=/opt/cherryfruitz/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Bloc nginx — déjà créé et actif : `/etc/nginx/sites-enabled/cherryfruitz`

Base (`deploy/nginx-cherryfruitz.conf` dans le repo) avant l'intervention de Certbot :

```nginx
server {
    server_name cherryfruitz.com www.cherryfruitz.com;
    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    listen 80;
}
```

Certbot a déjà tourné (`certbot --nginx -d cherryfruitz.com -d www.cherryfruitz.com`) et a réécrit ce fichier pour ajouter `listen 443 ssl` + la redirection HTTP→HTTPS — sur le même modèle que celui de TLPosta. **Ne jamais relancer cette commande** : le certificat existe déjà dans `/etc/letsencrypt/live/cherryfruitz.com/`.

### Checklist de déploiement (à chaque mise à jour)

1. `nginx -t` avant tout `systemctl reload nginx` (valide la config sans l'appliquer si erreur)
2. Vérifier que le port choisi n'entre jamais en collision avec `3000` (TLPosta)
3. Ne jamais lancer de commande `systemctl restart`/`reload` visant `igposta` depuis ce projet
4. Toujours vérifier après coup que `igposta.service` est toujours `active (running)` (`systemctl status igposta --no-pager`) — un simple filet de sécurité, cette action ne devrait jamais l'affecter si l'isolation ci-dessus est respectée

## 5. Prochain projet : sous-domaine `smonster.tlposta.com`

**Ce projet n'est pas encore commencé.** Cette section fixe la convention à suivre, sur le modèle exact de cherryfruitz (§4) mais pour un **sous-domaine** de `tlposta.com` plutôt qu'un domaine à part — donc pas de nouvel A record à poser chez le registrar pour un domaine complet, juste un sous-domaine (voir DNS plus bas), et un certificat SSL **dédié à ce sous-domaine**, jamais une extension du certificat existant de `tlposta.com`.

### DNS (déjà fait ou à faire côté Namecheap, zone `tlposta.com`)

- Type `A Record`, Host `smonster`, Value `95.111.242.100` (même VPS), TTL Automatic
- Ne touche à aucun des enregistrements existants de `tlposta.com` (`@`, `www`)
- Propagation : quelques minutes à ~1h ; vérifier avec `dig smonster.tlposta.com` avant de lancer `certbot`

### Convention d'isolation (identique à cherryfruitz, adaptée)

- Répertoire app : `/opt/smonster` (jamais dans `/opt/igposta` ni `/opt/cherryfruitz`)
- Port interne : `3002` — **`3000` (igposta) et `3001` (cherryfruitz) sont pris** ; revérifier quand même avec `ss -tlnp` avant de fixer définitivement
- Base de données : au choix du projet (SQLite recommandé par défaut ici aussi, sauf besoin particulier), fichier dédié sous `/opt/smonster/data/`, jamais dans un dossier d'un autre projet
- Nom du service systemd : `smonster.service` (fichier `/etc/systemd/system/smonster.service`), par analogie avec le bloc de cherryfruitz en §4 — `WorkingDirectory=/opt/smonster`, adapter `ExecStart` au point d'entrée réel
- Nouveau fichier nginx `/etc/nginx/sites-available/smonster` (puis lien symbolique dans `sites-enabled/`) :

```nginx
server {
    server_name smonster.tlposta.com;
    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    listen 80;
}
```

- Certificat SSL **séparé**, jamais un `--expand` du certificat de `tlposta.com` :

```bash
certbot --nginx -d smonster.tlposta.com
```

  Certbot crée `/etc/letsencrypt/live/smonster.tlposta.com/` (nouveau, indépendant) et réécrit uniquement `sites-enabled/smonster` pour ajouter `listen 443 ssl` + la redirection HTTP→HTTPS — il ne touche ni au fichier `igposta`, ni à `cherryfruitz`, ni à leurs certificats respectifs.

### Checklist avant toute action sur le VPS partagé

1. `nginx -t` avant tout `systemctl reload nginx`
2. Confirmer que le port choisi (`3002` par défaut) ne collisionne ni avec `3000` ni `3001`
3. Ne jamais viser `igposta` ou `cherryfruitz` avec `systemctl stop/restart/reload`, ni éditer leurs fichiers nginx/service/DB
4. Après toute action, vérifier que les deux services existants tournent toujours : `systemctl status igposta cherryfruitz --no-pager` (doivent rester `active (running)`)
5. Demander confirmation explicite à l'utilisateur avant toute action réelle sur ce serveur partagé (DNS déjà posé, mais SSH/nginx/systemd = infra partagée)
