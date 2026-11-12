#!/bin/sh
# Contrôle du stockage des pièces de vérification d'identité, une fois le parcours de bout en
# bout terminé (smoke-identity.sh) :
#
#   - les pièces envoyées y sont, une par fichier ;
#   - ni les fichiers ni les répertoires ne sont accessibles à un autre utilisateur ;
#   - aucun fichier ne commence par la signature d'une image ou d'un PDF : chacun est une
#     enveloppe chiffrée (octet de version, nonce, contenu chiffré, étiquette d'authenticité).
#
# S'exécute là où le stockage est monté — dans le conteneur de l'API :
#
#   docker compose --profile app exec -T api sh -s < infrastructure/ci/check-kyc-storage.sh
#
#   check-kyc-storage.sh [répertoire] [nombre minimal de pièces]
set -eu

dir="${1:-${KYC_STORAGE_DIR:-/var/lib/mgx/kyc}}"
expected="${2:-2}"

fail() {
  echo "FAIL  $1" >&2
  exit 1
}

[ -d "$dir" ] || fail "document storage $dir does not exist"

files="$(find "$dir" -type f | wc -l)"
[ "$files" -ge "$expected" ] || fail "expected at least $expected stored documents in $dir, found $files"
echo "ok    $files stored documents in $dir"

exposed="$(find "$dir" \( -type f -o -type d \) -perm /077 | wc -l)"
[ "$exposed" -eq 0 ] || fail "$exposed files or directories of $dir are accessible to other users"
echo "ok    nothing in the storage is accessible to other users"

leftovers="$(find "$dir" -type f -name '*.tmp' | wc -l)"
[ "$leftovers" -eq 0 ] || fail "$leftovers unfinished temporary files were left in $dir"
echo "ok    no unfinished temporary file"

find "$dir" -type f | while IFS= read -r file; do
  signature="$(head -c 4 "$file" | od -An -tx1 | tr -d ' \n')"
  case "$signature" in
    ffd8ff* | 89504e47 | 25504446) fail "$file starts with the signature of an image or a PDF: it is not encrypted" ;;
    01*) ;;
    *) fail "$file is not an encrypted envelope (unexpected first bytes: $signature)" ;;
  esac
  # Enveloppe : 1 octet de version, 12 de nonce, 16 d'étiquette — et la pièce, d'au moins 1 Ko.
  size="$(wc -c < "$file")"
  [ "$size" -ge 1053 ] || fail "$file is too small to be an encrypted document ($size bytes)"
done
echo "ok    every stored document is an encrypted envelope: none starts as an image or a PDF"
