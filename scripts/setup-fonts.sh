#!/usr/bin/env bash
# Complète le fingerprint de polices pour les profils macOS/iOS (webkit) : cette distribution
# alias déjà très bien Arial/Times New Roman/Courier New/Calibri vers leurs équivalents
# métriquement compatibles (Liberation Sans/Serif/Mono, Carlito — cf. /etc/fonts/conf.d/
# 30-metric-aliases.conf), mais n'a AUCUN équivalent pour "Helvetica Neue"/"Menlo"/"Monaco" :
# vérifié empiriquement, ces noms mesurent aujourd'hui exactement comme une police inexistante
# (fallback générique), ce qui est cohérent en soi (cf. applyFontFingerprintDefense dans
# driverBuilder.ts, qui masque déjà les polices Linux qui ne devraient pas exister sous ces noms
# sur macOS) mais laisse ces polices macOS *attendues* absentes plutôt que présentes.
#
# Ce script ajoute un alias fontconfig PAR UTILISATEUR (~/.config/fontconfig/fonts.conf, pas
# besoin de sudo) qui fait pointer ces noms vers de vrais substituts déjà installés, avec le même
# mécanisme <alias>/<accept> que celui utilisé par le système pour Arial → Liberation Sans.
# Idempotent : peut être relancé sans dupliquer le fichier. À exécuter sur chaque machine qui
# lance des profils webkit/macOS (ce poste, et le VPS le moment venu).
set -euo pipefail

CONF_DIR="$HOME/.config/fontconfig"
CONF_FILE="$CONF_DIR/fonts.conf"

mkdir -p "$CONF_DIR"

cat > "$CONF_FILE" <<'EOF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <!-- Complète 30-metric-aliases.conf (Arial/Times/Courier/Calibri) pour les polices macOS/iOS
       qui n'ont pas d'équivalent système : "Helvetica" hérite déjà de la chaîne existante
       (-> Nimbus Sans), donc on y raccroche "Helvetica Neue" plutôt que de dupliquer la cible. -->
  <alias binding="same">
    <family>Helvetica Neue</family>
    <accept>
      <family>Helvetica</family>
    </accept>
  </alias>
  <alias binding="same">
    <family>Menlo</family>
    <accept>
      <family>Liberation Mono</family>
    </accept>
  </alias>
  <alias binding="same">
    <family>Monaco</family>
    <accept>
      <family>Liberation Mono</family>
    </accept>
  </alias>
</fontconfig>
EOF

fc-cache -f "$CONF_DIR" > /dev/null

echo "Fontconfig utilisateur mis à jour : $CONF_FILE"
echo "Vérification :"
for f in "Helvetica Neue" "Menlo" "Monaco"; do
  echo -n "  $f -> "
  fc-match "$f"
done
