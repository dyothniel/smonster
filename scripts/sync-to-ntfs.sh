#!/usr/bin/env bash
# Synchronise les modifications faites sur cette copie Linux vers la copie NTFS partagée
# (Windows/Linux dual-boot), où `npm install`/les tests tournent depuis Windows. Jamais l'inverse
# depuis ce script : il écrase TOUJOURS NTFS <- Linux, jamais Linux <- NTFS.
#
# Exclut `.git/` (chaque copie garde son propre historique/config — un `rsync` de `.git/` écrase
# silencieusement `core.fileMode false`, posé uniquement côté NTFS pour contourner un faux positif
# du mount FUSE, cf. README.md), `node_modules/` et `dist/` (spécifiques à l'OS qui les installe/
# build, jamais synchronisés : npm install doit tourner sous Windows sur la copie NTFS).
set -euo pipefail

SRC="/home/thinolord/Projets/smonster/"
DST="/run/media/thinolord/3692CE7D92CE415B/MySoft/Project/smonster/"

if [ ! -d "$DST" ]; then
  echo "Destination introuvable, le disque NTFS est-il monté ? ($DST)" >&2
  exit 1
fi

rsync -a --delete \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.git/' \
  "$SRC" "$DST"

echo "Sync terminé: $SRC -> $DST"
