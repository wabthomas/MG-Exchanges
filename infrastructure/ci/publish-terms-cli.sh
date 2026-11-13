#!/usr/bin/env bash
# Publication d'une version des conditions d'utilisation avec l'outil en ligne de commande,
# dans la pile Docker Compose — telle que docs/DEPLOYMENT.md la donne : image de migration,
# rôle propriétaire de la base, dossier des textes monté en lecture seule.
#
# À exécuter depuis la racine du dépôt, la pile `--profile app` démarrée, après
# smoke-identity.sh (une version au moins est alors publiée) :
#
#   BASE_URL=http://127.0.0.1:8080 infrastructure/ci/publish-terms-cli.sh
#
# Ce qui est vérifié :
#   - un numéro qui n'est pas le suivant est refusé (code de sortie 1), et rien n'est publié ;
#   - la version suivante est publiée, « pour information » ;
#   - la marque d'ordre des octets en tête du fichier n'entre pas dans le texte ;
#   - l'empreinte et le texte servis à travers le proxy sont ceux du fichier, à l'octet près.
#
# Hors Docker (répétition de la pile), TERMS_CLI désigne un exécutable qui lance l'outil sur
# place : `$TERMS_CLI terms:publish …`. Les fichiers sont alors lus dans leur dossier d'origine.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
API="$BASE_URL/api/v1"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL  $1" >&2
  exit 1
}

# Le fichier à publier commence par une marque d'ordre des octets (EF BB BF), comme en placent
# certains éditeurs ; le texte attendu est le même, sans elle. Fins de ligne mêlées, apostrophe
# typographique et tiret : rien ne doit en être retouché.
printf '\357\273\277# Conditions \342\200\224 publi\303\251es par l\342\200\231outil\r\n\r\nArticle 1.\n' > "$WORK/fr.md"
printf '# Conditions \342\200\224 publi\303\251es par l\342\200\231outil\r\n\r\nArticle 1.\n' > "$WORK/expected.md"
# Le dossier monté et ses fichiers doivent être lisibles par l'utilisateur de l'image (node).
chmod -R a+rX "$WORK"

if [ -n "${TERMS_CLI:-}" ]; then
  texts="$WORK"
  run_tool() { "$TERMS_CLI" "$@"; }
else
  texts=/terms
  run_tool() {
    docker compose --profile app run --rm --volume "$WORK:/terms:ro" \
      migrate node dist/cli/main.js "$@"
  }
fi

# publish <numéro> — publie le fichier comme version « pour information ».
publish() {
  run_tool terms:publish --number "$1" --requires-acceptance no \
    --reason "Publication de contrôle de la pile conteneurisée" \
    --fr "$texts/fr.md" --fr-summary "Publiée par l'outil en ligne de commande."
}

current_number() {
  curl --fail --silent --show-error "$API/terms/current" | jq --raw-output .number
}

current="$(current_number)"
next="$((current + 1))"

# Un numéro qui n'est pas le suivant : l'outil refuse, et le dit par son code de sortie.
status=0
publish "$((next + 1))" || status=$?
[ "$status" = "1" ] || fail "terms:publish with a number that is not the next one -> exit $status (expected 1)"
[ "$(current_number)" = "$current" ] || fail "a version was published although the number was refused"
echo "ok    a number that is not the next one is refused (exit 1), nothing is published"

publish "$next"
echo "ok    version $next published from the command line"

curl --fail --silent --show-error "$API/terms/current" > "$WORK/current.json"
digest="$(sha256sum "$WORK/expected.md" | cut -d ' ' -f 1)"
if ! jq --exit-status --argjson number "$next" --arg digest "$digest" \
  '.number == $number and .current == true and .requiresAcceptance == false and .sha256 == $digest' \
  "$WORK/current.json" > /dev/null; then
  jq 'del(.body)' "$WORK/current.json" >&2
  fail "the version in force is not the one just published, or its digest is not that of the file ($digest)"
fi
echo "ok    it is in force, for information; its digest is that of the file without its byte order mark"

jq --join-output .body "$WORK/current.json" > "$WORK/served.md"
cmp --silent "$WORK/served.md" "$WORK/expected.md" || fail "the text served through the proxy differs from the file"
echo "ok    the text served through the proxy is the file, byte for byte ($(wc -c < "$WORK/expected.md") bytes)"
