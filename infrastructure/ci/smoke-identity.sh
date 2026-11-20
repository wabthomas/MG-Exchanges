#!/usr/bin/env bash
# Parcours d'identité de bout en bout, à travers le reverse proxy, sur une pile démarrée :
#
#   1. l'administrateur se connecte ; le back-office lui est fermé tant qu'il n'a pas activé la
#      validation en deux étapes ; il l'active (secret TOTP, premier code, codes de secours) ;
#   2. il ouvre l'inscription, puis publie les conditions d'utilisation — un texte de plusieurs
#      centaines de kilo-octets, à travers le proxy — : avant cela nul ne peut s'inscrire ;
#      le texte se relit sans compte, à l'octet près ;
#   3. un utilisateur s'inscrit en acceptant la version en vigueur, reçoit son code dans la boîte
#      de développement, vérifie son adresse avec son mot de passe, se connecte, consulte son
#      compte, n'a aucun droit d'administration, renouvelle sa session, complète son profil ;
#   4. l'administrateur se reconnecte en deux étapes (code de secours), puis publie une nouvelle
#      version, à accepter : le compte de l'utilisateur lui est fermé jusqu'à ce qu'il l'accepte ;
#   5. vérification d'identité : l'administrateur ouvre la fonctionnalité ; l'utilisateur déclare
#      son identité, envoie ses pièces — des fichiers de plusieurs centaines de kilo-octets, puis
#      de la taille maximale, à travers le proxy —, dépose son dossier ; l'administrateur le
#      trouve dans la file, relit une pièce à l'identique et accepte le dossier ; le compte est
#      vérifié et son profil reprend l'identité de la pièce ;
#   6. grand livre : l'administrateur enregistre un actif ; l'utilisateur y dispose aussitôt
#      d'un portefeuille à zéro, sans mouvement ; aucun compte n'est ouvert, et la balance du
#      grand livre est équilibrée ;
#   7. transferts entre titulaires : l'administrateur ouvre la fonctionnalité ; tant qu'aucun
#      plafond n'est fixé pour son niveau de vérification, l'utilisateur ne peut rien envoyer ;
#      l'administrateur fixe les plafonds, l'utilisateur les lit ; une demande sans clé
#      d'idempotence, sans le bon mot de passe, au-delà du plafond ou au-delà du solde est
#      refusée, chacune pour sa raison, sans que rien ne bouge ;
#   8. opérations du personnel : les ajustements manuels sont fermés, l'administrateur les
#      ouvre ; il demande le crédit du portefeuille de l'utilisateur — rien ne bouge —, et ne
#      peut pas l'approuver lui-même. **Avec un second administrateur** : celui-ci l'approuve en
#      présentant de nouveau son mot de passe et son second facteur, le portefeuille est
#      crédité, et l'utilisateur fait un vrai transfert vers un autre compte — renvoyé sous la
#      même clé, il n'est pas fait deux fois. L'administrateur gèle alors le portefeuille : plus
#      rien n'en part, le compte ne se clôt pas ; un débit sous double validation en sort
#      pourtant le solde ; le gel est levé. Sans second administrateur, la demande est retirée,
#      et seul le gel est éprouvé ;
#   9. l'administrateur retrouve le compte par son adresse et ferme ses sessions ;
#  10. l'utilisateur se reconnecte, obtient la copie de ses données, puis clôt son compte : il
#      ne peut plus se connecter, il est prévenu à son ancienne adresse, son dossier de
#      vérification est conservé, et le back-office retrouve le compte clôturé.
#
# Prérequis :
#   - un compte administrateur NEUF, créé avec l'outil en ligne de commande (`admin:create`) :
#     le script active son second facteur et n'en conserve pas le secret, il ne peut donc pas
#     être rejoué avec le même compte ;
#   - pour la double validation, un SECOND compte administrateur neuf, créé de même, désigné
#     par SECOND_ADMIN_EMAIL et SECOND_ADMIN_PASSWORD : nul n'approuve sa propre demande, et
#     aucune route ne crée un administrateur. Sous GitHub Actions, où le workflow ne peut pas
#     être modifié d'ici, le script le crée lui-même — par la commande `docker compose` que
#     l'étape du workflow vient d'employer pour le premier — et échoue s'il n'en a pas : la
#     double validation n'y est pas facultative. Ailleurs, sans second administrateur, il la
#     saute et le dit ;
#   - la remise des notifications en mémoire (environnement local) ;
#   - le stockage chiffré des pièces configuré (KYC_ENCRYPTION_KEY) ;
#   - curl, jq, openssl, sha256sum et python3 (calcul du code TOTP, dates, textes).
#
# Le script publie deux versions des conditions d'utilisation et enregistre un actif — l'un
# et l'autre définitifs — ; il ouvre l'inscription, la vérification d'identité, les transferts
# entre titulaires et les ajustements manuels, et les laisse ouverts ; il crédite un
# portefeuille : il est fait pour une pile de test, jamais pour une plateforme en service.
#
# Toutes ses requêtes partent d'une même adresse : hors connexion, inscription, lecture des
# conditions et demandes de transfert, elles sont comptées ensemble par la limitation de débit
# de l'API (120 par minute par défaut) — et le parcours en compte davantage. Il se règle donc
# sur ce que l'API annonce, comme doit le faire tout client : lorsque la limite approche, il
# attend la fin de la fenêtre (une minute au plus).
#
#   BASE_URL=http://127.0.0.1:8080 ADMIN_EMAIL=… MGX_ADMIN_PASSWORD=… \
#     [SECOND_ADMIN_EMAIL=… SECOND_ADMIN_PASSWORD=…] ./smoke-identity.sh
set -euo pipefail

: "${BASE_URL:?}" "${ADMIN_EMAIL:?}" "${MGX_ADMIN_PASSWORD:?}"
API="$BASE_URL/api/v1"
BODY="$(mktemp)"
HEADERS="$(mktemp)"
WORK="$(mktemp -d)"
trap 'rm -rf "$BODY" "$HEADERS" "$WORK"' EXIT

# header <nom> — valeur d'un en-tête de la dernière réponse ; rien s'il est absent.
header() {
  awk -v name="$(printf '%s:' "$1" | tr '[:upper:]' '[:lower:]')" \
    'tolower($1) == name { sub(/\r$/, "", $2); value = $2 } END { print value }' "$HEADERS"
}

# Limite de débit générale de l'API : lue sur la première réponse qui l'annonce. En deçà de
# RATE_MARGIN requêtes restantes, le parcours attend la fin de la fenêtre.
RATE_LIMIT=""
RATE_MARGIN=5
# Ce que le parcours a envoyé, dit à la fin : le nombre de réponses reçues, celles que la
# limite générale a comptées, le plus petit reste qu'elle a annoncé, et les pauses.
REQUESTS=0
COUNTED=0
LOWEST=""
PAUSES=0

# pace — à appeler après chaque réponse. Chaque réponse annonce la limite qui l'a comptée
# (X-RateLimit-Limit), ce qu'il en reste et dans combien de secondes sa fenêtre se referme. Les
# routes qui ont leur propre limite — connexion, inscription, transferts — en annoncent une
# autre : le parcours n'y fait que quelques requêtes, et ne s'en occupe pas.
pace() {
  local limit remaining reset
  REQUESTS=$((REQUESTS + 1))
  limit="$(header X-RateLimit-Limit)"
  remaining="$(header X-RateLimit-Remaining)"
  reset="$(header X-RateLimit-Reset)"
  [ -n "$limit" ] && [ -n "$remaining" ] && [ -n "$reset" ] || return 0
  [ -n "$RATE_LIMIT" ] || RATE_LIMIT="$limit"
  [ "$limit" = "$RATE_LIMIT" ] || return 0
  COUNTED=$((COUNTED + 1))
  if [ -z "$LOWEST" ] || [ "$remaining" -lt "$LOWEST" ]; then
    LOWEST="$remaining"
  fi
  if [ "$remaining" -le "$RATE_MARGIN" ] && [ "$reset" -le 120 ]; then
    PAUSES=$((PAUSES + 1))
    echo "wait  $remaining request(s) left before the rate limit: pausing ${reset}s, until its window ends"
    sleep "$((reset + 1))"
  fi
}

# request <statut attendu> <méthode> <chemin> [corps JSON] [jeton] [en-tête] — le corps de la
# réponse est dans $BODY.
request() {
  local expected="$1" method="$2" path="$3" data="${4:-}" token="${5:-}" header="${6:-}" status
  local -a args=(--silent --show-error --output "$BODY" --dump-header "$HEADERS"
    --write-out '%{http_code}' --request "$method")
  [ -n "$data" ] && args+=(--header 'Content-Type: application/json' --data "$data")
  [ -n "$token" ] && args+=(--header "Authorization: Bearer $token")
  [ -n "$header" ] && args+=(--header "$header")
  # Un échec de curl ne doit pas interrompre le script sans explication : le statut reçu
  # (000 s'il n'y en a pas eu) est comparé à celui qui est attendu.
  status="$(curl "${args[@]}" "$API$path")" || true
  if [ "$status" != "$expected" ]; then
    echo "FAIL  $method $path -> $status (expected $expected)" >&2
    cat "$BODY" >&2
    exit 1
  fi
  echo "ok    $method $path -> $status"
  pace
}

# upload <statut attendu> <chemin> <type de contenu> <fichier> [jeton] — envoie le fichier
# lui-même comme corps de la requête ; le corps de la réponse est dans $BODY.
upload() {
  local expected="$1" path="$2" content_type="$3" file="$4" token="${5:-}" status
  local -a args=(--silent --show-error --output "$BODY" --dump-header "$HEADERS"
    --write-out '%{http_code}' --request POST
    --header "Content-Type: $content_type" --data-binary "@$file")
  [ -n "$token" ] && args+=(--header "Authorization: Bearer $token")
  # Un refus peut arriver avant la fin de l'envoi : curl s'interrompt alors, parfois avec un
  # code d'erreur, mais il a reçu la réponse — c'est elle qui est vérifiée.
  status="$(curl "${args[@]}" "$API$path")" || true
  if [ "$status" != "$expected" ]; then
    echo "FAIL  POST $path ($(wc -c < "$file") bytes) -> $status (expected $expected)" >&2
    cat "$BODY" >&2
    exit 1
  fi
  echo "ok    POST $path ($(wc -c < "$file") bytes) -> $status"
  pace
}

# test_file <fichier> <signature (échappements printf)> <taille totale en octets> — fichier de
# test : la signature du format, suivie d'octets aléatoires.
test_file() {
  local file="$1" signature="$2" size="$3" header_size
  printf "$signature" > "$file"
  header_size="$(wc -c < "$file")"
  head -c "$((size - header_size))" /dev/urandom >> "$file"
}

# days_from_today <nombre de jours, éventuellement négatif> — jour civil (UTC), AAAA-MM-JJ.
days_from_today() {
  python3 -c 'import datetime, sys; print((datetime.datetime.now(datetime.timezone.utc).date() + datetime.timedelta(days=int(sys.argv[1]))).isoformat())' "$1"
}

# check <description> <filtre jq> — le filtre doit être vrai pour le corps de la dernière réponse.
check() {
  if ! jq -e "$2" "$BODY" >/dev/null; then
    echo "FAIL  $1" >&2
    cat "$BODY" >&2
    exit 1
  fi
  echo "ok    $1"
}

# Code à six chiffres d'une application d'authentification (TOTP, RFC 6238) pour un secret base32.
totp() {
  python3 - "$1" <<'PYTHON'
import base64, hashlib, hmac, struct, sys, time

key = base64.b32decode(sys.argv[1])
digest = hmac.new(key, struct.pack('>Q', int(time.time()) // 30), hashlib.sha1).digest()
offset = digest[-1] & 0x0F
print(f"{(struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}")
PYTHON
}

# next_code <fichier> — le prochain code de secours d'un administrateur, retiré du fichier.
next_code() {
  local code
  code="$(head -n 1 "$1")"
  [ -n "$code" ] || { echo "FAIL  no recovery code left in $1" >&2; exit 1; }
  sed -i '1d' "$1"
  printf '%s' "$code"
}

admin_credentials="$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$MGX_ADMIN_PASSWORD" '{email: $e, password: $p}')"

# Le second administrateur : fourni par l'appelant, ou — sous GitHub Actions, dans le dépôt —
# créé ici par la commande que le workflow vient d'employer pour le premier.
second_admin_email="${SECOND_ADMIN_EMAIL:-}"
second_admin_password="${SECOND_ADMIN_PASSWORD:-}"
if [ -z "$second_admin_email" ] && [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -f docker-compose.yml ]; then
  second_admin_email="second-$ADMIN_EMAIL"
  second_admin_password="ci-$(openssl rand -hex 16)"
  MGX_ADMIN_PASSWORD="$second_admin_password" docker compose --profile app run --rm \
    --env MGX_ADMIN_PASSWORD migrate node dist/cli/main.js admin:create --email "$second_admin_email"
  echo "ok    second administrator created with the command-line tool"
fi
if [ -n "$second_admin_email" ] && [ -z "$second_admin_password" ]; then
  echo "FAIL  SECOND_ADMIN_EMAIL is set without SECOND_ADMIN_PASSWORD" >&2
  exit 1
fi
# Sous GitHub Actions, la double validation n'est pas facultative : sans second administrateur,
# le parcours échoue — une exécution réussie de l'intégration continue prouve qu'elle a eu lieu.
if [ -z "$second_admin_email" ] && [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "FAIL  under GitHub Actions the journey needs a second administrator: run it from the root of the repository, or set SECOND_ADMIN_EMAIL and SECOND_ADMIN_PASSWORD" >&2
  exit 1
fi

# --- 1. Administrateur : le mot de passe ne suffit pas pour le back-office ---------------------
request 401 GET /me
request 200 POST /auth/login "$admin_credentials"
if [ "$(jq -r .status "$BODY")" != "AUTHENTICATED" ]; then
  echo "FAIL  this administrator already has two-step verification: create a fresh one (admin:create)" >&2
  exit 1
fi
admin_token="$(jq -r .tokens.accessToken "$BODY")"
check 'the administrator holds the super_admin role' '.user.roles == ["super_admin"]'

request 403 GET /admin/system-settings '' "$admin_token"
check 'the back office requires two-step verification' '.code == "MFA_ENROLLMENT_REQUIRED"'

request 200 POST /me/mfa/totp/enroll "$(jq -n --arg p "$MGX_ADMIN_PASSWORD" '{currentPassword: $p}')" "$admin_token"
totp_secret="$(jq -r .secret "$BODY")"
request 200 POST /me/mfa/totp/confirm "$(jq -n --arg c "$(totp "$totp_secret")" '{code: $c}')" "$admin_token"
check 'ten recovery codes are handed over' '.recoveryCodes | length == 10'
# Un code de secours ne sert qu'une fois : le parcours les prend l'un après l'autre.
jq -r '.recoveryCodes[]' "$BODY" > "$WORK/codes-1"
recovery_code="$(next_code "$WORK/codes-1")"

# --- 2. Ouverture de l'inscription ---------------------------------------------------------------
request 200 PUT /admin/system-settings/features.registration \
  '{"value": true, "reason": "Smoke test of the containerised stack"}' "$admin_token"

email="smoke-$(date +%s)-$RANDOM@example.cd"
password="smoke-test-$(openssl rand -hex 8)"
credentials="$(jq -n --arg e "$email" --arg p "$password" '{email: $e, password: $p}')"

# --- 2 bis. Conditions d'utilisation -----------------------------------------------------------
# Sur une pile neuve, aucune version n'est publiée ; sur une pile déjà utilisée, le script
# publie la suivante.
status="$(curl --silent --output "$BODY" --dump-header "$HEADERS" --write-out '%{http_code}' "$API/terms/current")"
pace
case "$status" in
  404)
    terms_version=1
    # Tant qu'aucune version n'est publiée, nul ne s'inscrit — dès que l'inscription est
    # ouverte (visible en quelques secondes au plus sur chaque instance).
    for _ in $(seq 1 20); do
      status="$(curl --silent --output "$BODY" --dump-header "$HEADERS" --write-out '%{http_code}' --header 'Content-Type: application/json' \
        --data "$(jq -n --arg e "$email" --arg p "$password" '{email: $e, password: $p, countryCode: "CD", acceptedTermsVersion: 1}')" \
        "$API/auth/register")"
      pace
      [ "$status" = "503" ] && break
      sleep 0.5
    done
    [ "$status" = "503" ] || { echo "FAIL  POST /auth/register before any terms -> $status (expected 503)" >&2; cat "$BODY" >&2; exit 1; }
    echo "ok    POST /auth/register -> 503 (no terms of use published yet)"
    ;;
  200)
    terms_version="$(($(jq -r .number "$BODY") + 1))"
    ;;
  *)
    echo "FAIL  GET /terms/current -> $status (expected 200 or 404)" >&2; cat "$BODY" >&2; exit 1
    ;;
esac

# Un texte de 180 000 caractères environ (la limite est de 200 000) — fins de ligne mêlées,
# tabulation, accents, guillemets —, soit plus de 180 kilo-octets : au-delà de la limite commune
# des corps de requête (128 Ko au proxy, 100 Ko à l'API). Seule la route de publication l'admet.
python3 - "$WORK/terms-fr.md" <<'PYTHON'
import sys

text = (
    "# Conditions d’utilisation\r\n\r\nArticle 1 — Objet.  \n\t« Œuvre » de test.\n\n"
    + "Clause de remplissage, sans portée. " * 5000
    + "\nFin.\n"
)
with open(sys.argv[1], "w", encoding="utf-8", newline="") as file:
    file.write(text)
PYTHON
terms_digest="$(sha256sum "$WORK/terms-fr.md" | cut -d ' ' -f 1)"
# publication <fichier JSON> <numéro> <true|false : version à accepter> <fichier du texte>
publication() {
  jq -n --argjson n "$2" --argjson r "$3" --rawfile body "$4" '{
    number: $n, requiresAcceptance: $r, reason: "Smoke test of the containerised stack",
    fr: {summary: "Version de test.", body: $body}}' > "$1"
}
publication "$WORK/terms.json" "$terms_version" true "$WORK/terms-fr.md"

# Sans jeton, la publication est refusée — avant que son contenu ne soit lu.
upload 401 /admin/terms/versions application/json "$WORK/terms.json"
# Au-delà d'un mébioctet, l'API refuse ; au-delà de la limite du proxy pour cette route, le
# proxy refuse sans rien transmettre.
head -c 1060000 /dev/zero | tr '\0' 'x' > "$WORK/filler.txt"
publication "$WORK/terms-too-large.json" "$terms_version" true "$WORK/filler.txt"
upload 413 /admin/terms/versions application/json "$WORK/terms-too-large.json" "$admin_token"
check 'beyond one mebibyte the API refuses the publication' \
  '.code == "PAYLOAD_TOO_LARGE" and (.detail | contains("1048576"))'
head -c 1300000 /dev/zero | tr '\0' 'x' > "$WORK/filler.txt"
publication "$WORK/terms-too-large.json" "$terms_version" true "$WORK/filler.txt"
upload 413 /admin/terms/versions application/json "$WORK/terms-too-large.json" "$admin_token"
check 'beyond the limit of this route the request is refused' '.code == "PAYLOAD_TOO_LARGE"'

upload 201 /admin/terms/versions application/json "$WORK/terms.json" "$admin_token"
check 'the version is published and its digest is that of the file' \
  ".number == $terms_version and .current == true and .requiresAcceptance == true and .fr.sha256 == \"$terms_digest\" and .acceptances == 0"
# Une publication ne se rejoue pas.
upload 409 /admin/terms/versions application/json "$WORK/terms.json" "$admin_token"

# Le texte se lit sans compte, tel qu'il a été publié : à l'octet près, à travers le proxy.
request 200 GET /terms/current
check 'the version in force is the one just published' \
  ".number == $terms_version and .locale == \"fr\" and .sha256 == \"$terms_digest\""
jq -j .body "$BODY" > "$WORK/terms-read.md"
if ! cmp -s "$WORK/terms-read.md" "$WORK/terms-fr.md"; then
  echo "FAIL  the text read back differs from the published file" >&2
  exit 1
fi
echo "ok    the text read back is the published file, byte for byte ($(wc -c < "$WORK/terms-fr.md") bytes)"
request 200 GET "/terms/versions/$terms_version?locale=en"
check 'without a translation the French text is served' '.locale == "fr" and .locales == ["fr"]'

# --- 3. Utilisateur ----------------------------------------------------------------------------
# L'ouverture d'une fonctionnalité est visible en quelques secondes au plus sur chaque instance.
for _ in $(seq 1 20); do
  status="$(curl --silent --output "$BODY" --dump-header "$HEADERS" --write-out '%{http_code}' --header 'Content-Type: application/json' \
    --data "$(jq -n --arg e "$email" --arg p "$password" --argjson v "$terms_version" '{email: $e, password: $p, countryCode: "CD", acceptedTermsVersion: $v}')" \
    "$API/auth/register")"
  pace
  [ "$status" = "202" ] && break
  sleep 0.5
done
[ "$status" = "202" ] || { echo "FAIL  POST /auth/register -> $status" >&2; cat "$BODY" >&2; exit 1; }
echo "ok    POST /auth/register -> 202"
# S'inscrire, c'est accepter la version en vigueur : une autre est refusée, quelle que soit
# l'adresse.
request 409 POST /auth/register "$(jq -n --arg e "autre-$email" --arg p "$password" --argjson v "$((terms_version + 1))" \
  '{email: $e, password: $p, countryCode: "CD", acceptedTermsVersion: $v}')"
check 'registration names the version in force' '.code == "TERMS_VERSION_NOT_CURRENT"'

# Le code est émis par un traitement asynchrone (boîte d'envoi, puis file de traitement).
code=""
for _ in $(seq 1 60); do
  curl --silent --output "$BODY" --dump-header "$HEADERS" "$API/dev/mailbox?recipient=$email"
  pace
  code="$(jq -r '.messages[0].text // ""' "$BODY" | grep -oE '\b[0-9]{6}\b' | head -n 1 || true)"
  [ -n "$code" ] && break
  sleep 0.5
done
[ -n "$code" ] || { echo "FAIL  no verification code received" >&2; exit 1; }
echo "ok    verification code received"

request 403 POST /auth/login "$credentials"
# Le code ne suffit pas : il faut aussi le mot de passe choisi à l'inscription.
request 401 POST /auth/email/verify "$(jq -n --arg e "$email" --arg c "$code" '{email: $e, code: $c, password: "not-the-password-1"}')"
request 204 POST /auth/email/verify "$(jq -n --arg e "$email" --arg c "$code" --arg p "$password" '{email: $e, code: $c, password: $p}')"
request 200 POST /auth/login "$credentials"
check 'a password alone signs in an account without two-step verification' '.status == "AUTHENTICATED"'
user_token="$(jq -r .tokens.accessToken "$BODY")"
refresh_token="$(jq -r .tokens.refreshToken "$BODY")"
user_id="$(jq -r .user.id "$BODY")"

request 200 GET /me '' "$user_token"
check 'the account is active and has no permission' \
  ".email == \"$email\" and .status == \"ACTIVE\" and .permissions == [] and .secondFactorEnabled == false"
check 'having accepted the terms in force when signing up, the account has nothing to accept' \
  '.termsAcceptanceRequired == false'
request 200 GET /me/terms '' "$user_token"
check 'the acceptance was recorded with the account' \
  ".accepted.number == $terms_version and .current.number == $terms_version and .acceptanceRequired == false"
request 403 GET /admin/system-settings '' "$user_token"
request 403 GET /admin/users '' "$user_token"
request 200 POST /auth/refresh "$(jq -n --arg t "$refresh_token" '{refreshToken: $t}')"
request 200 PATCH /me/profile '{"givenName": "Smoke", "familyName": "Test", "timeZone": "Africa/Kinshasa"}' "$user_token"
check 'the profile is stored' '.givenName == "Smoke" and .timeZone == "Africa/Kinshasa"'
request 200 GET /me/activity '' "$user_token"
check 'the activity shows the sign-in' '[.entries[].type] | index("SIGN_IN") != null'

# --- 4. Administrateur : connexion en deux étapes, puis back-office ----------------------------
request 200 POST /auth/login "$admin_credentials"
check 'the administrator now signs in with two steps' '.status == "MFA_REQUIRED" and (has("tokens") | not)'
mfa_token="$(jq -r .mfaToken "$BODY")"
# Un code TOTP n'est accepté qu'une fois et celui de l'activation vient de servir : la seconde
# étape est franchie avec un code de secours, sans attendre le code suivant.
request 200 POST /auth/mfa/verify "$(jq -n --arg t "$mfa_token" --arg c "$recovery_code" '{mfaToken: $t, recoveryCode: $c}')"
admin_token="$(jq -r .tokens.accessToken "$BODY")"
# Le jeton de la connexion en cours ne sert qu'une fois.
request 401 POST /auth/mfa/verify "$(jq -n --arg t "$mfa_token" --arg c "$recovery_code" '{mfaToken: $t, recoveryCode: $c}')"

# --- 4 bis. Une nouvelle version des conditions, à accepter -------------------------------------
printf 'Conditions d’utilisation — version suivante.\n' > "$WORK/terms-next.md"
publication "$WORK/terms-next.json" "$((terms_version + 1))" true "$WORK/terms-next.md"
upload 201 /admin/terms/versions application/json "$WORK/terms-next.json" "$admin_token"
request 200 GET /admin/terms/versions '' "$admin_token"
check 'the back office follows the versions and their acceptances' \
  ".versions[0].number == $((terms_version + 1)) and .versions[0].current == true and .versions[1].number == $terms_version and .versions[1].acceptances >= 1"

# Le compte de l'utilisateur lui est fermé — sauf l'essentiel — jusqu'à ce qu'il accepte.
request 403 GET /me/profile '' "$user_token"
check 'the account must accept the new version before continuing' '.code == "TERMS_ACCEPTANCE_REQUIRED"'
request 200 GET /me '' "$user_token"
check 'the account is told so' '.termsAcceptanceRequired == true'
request 200 GET /me/sessions '' "$user_token"
# On n'accepte que la version en vigueur : celle qu'on a pu lire.
request 409 POST /me/terms/acceptance "$(jq -n --argjson v "$terms_version" '{version: $v}')" "$user_token"
check 'a superseded version cannot be accepted' '.code == "TERMS_VERSION_NOT_CURRENT"'
request 200 POST /me/terms/acceptance "$(jq -n --argjson v "$((terms_version + 1))" '{version: $v}')" "$user_token"
check 'the acceptance is recorded' \
  ".accepted.number == $((terms_version + 1)) and .acceptanceRequired == false"
request 200 GET /me/profile '' "$user_token"
request 200 GET /me/activity '' "$user_token"
check 'the activity shows both acceptances' '[.entries[] | select(.type == "TERMS_ACCEPTED")] | length == 2'

# --- 5. Vérification d'identité, pièces comprises, à travers le proxy ---------------------------
request 200 PUT /admin/system-settings/features.kyc \
  '{"value": true, "reason": "Smoke test of the containerised stack"}' "$admin_token"
# L'ouverture d'une fonctionnalité est visible en quelques secondes au plus sur chaque instance.
for _ in $(seq 1 20); do
  status="$(curl --silent --output "$BODY" --dump-header "$HEADERS" --write-out '%{http_code}' --header "Authorization: Bearer $user_token" "$API/me/verification")"
  pace
  [ "$status" = "200" ] && break
  sleep 0.5
done
[ "$status" = "200" ] || { echo "FAIL  GET /me/verification -> $status" >&2; cat "$BODY" >&2; exit 1; }
echo "ok    GET /me/verification -> 200"
check 'a new account is not verified: only level 1 is open' \
  '.level == 0 and [.levels[].available] == [true, false, false]'

document_number="SMOKE$(date +%s)$RANDOM"
declaration="$(jq -n --arg n "$document_number" \
  --arg issued "$(days_from_today -400)" --arg expires "$(days_from_today 1400)" '{
    givenName: "Jean", familyName: "Mukendi", additionalName: "Kabongo",
    dateOfBirth: "1990-05-17", placeOfBirth: "Lubumbashi", nationality: "CD",
    document: {type: "PASSPORT", number: $n, issuingCountry: "CD", issuedOn: $issued,
               issuedAt: "Kinshasa", expiresOn: $expires}}')"
request 200 PUT /me/verification/identity "$declaration" "$user_token"
case_id="$(jq -r .id "$BODY")"
check 'the draft is created and the document number comes back masked' \
  ".status == \"DRAFT\" and .missingDocuments == [\"IDENTITY_FRONT\", \"SELFIE\"] and (.identity.document.numberMasked | contains(\"$document_number\") | not)"
documents="/me/verification/cases/$case_id/documents"

# Des fichiers bien plus gros que la limite générale du proxy (128 Ko) : seule cette route les admet.
test_file "$WORK/front.jpg" '\377\330\377\340' 600000
test_file "$WORK/selfie.png" '\211PNG\r\n\032\n' 300000
test_file "$WORK/max.jpg" '\377\330\377\340' 5242880
test_file "$WORK/over.jpg" '\377\330\377\340' 5242881
test_file "$WORK/huge.jpg" '\377\330\377\340' 7000000

# Sans jeton, l'API refuse avant d'avoir lu le fichier — et le proxy relaie ce refus tel quel.
upload 401 "$documents?kind=IDENTITY_FRONT" image/jpeg "$WORK/max.jpg"
check 'the refusal comes from the API, in the error format' '.code == "UNAUTHENTICATED"'
upload 201 "$documents?kind=IDENTITY_FRONT" image/jpeg "$WORK/front.jpg" "$user_token"
upload 201 "$documents?kind=SELFIE" image/png "$WORK/selfie.png" "$user_token"
check 'both mandatory documents are attached' \
  '.missingDocuments == [] and ([.documents[].byteSize] | sort) == [300000, 600000]'
# Quatre envois lents en même temps depuis une même adresse : le proxy les transmet au fil de
# l'eau, et refuse le cinquième tant qu'ils sont en cours.
for slow in 1 2 3 4; do
  curl --silent --output "$WORK/slow-$slow.json" --write-out '%{http_code}' --limit-rate 100k \
    --request POST --header 'Content-Type: image/png' --header "Authorization: Bearer $user_token" \
    --data-binary "@$WORK/selfie.png" "$API$documents?kind=SELFIE" > "$WORK/slow-$slow.status" &
done
sleep 1
upload 429 "$documents?kind=SELFIE" image/png "$WORK/selfie.png" "$user_token"
check 'a fifth simultaneous upload from one address is refused by the proxy' '.code == "RATE_LIMITED"'
wait
for slow in 1 2 3 4; do
  if [ "$(cat "$WORK/slow-$slow.status")" != "201" ]; then
    echo "FAIL  slow upload $slow -> $(cat "$WORK/slow-$slow.status")" >&2
    cat "$WORK/slow-$slow.json" >&2
    exit 1
  fi
done
echo "ok    four slow simultaneous uploads went through"
request 200 GET "/me/verification/cases/$case_id" '' "$user_token"
check 'the selfie was replaced, not duplicated' \
  '([.documents[].byteSize] | sort) == [300000, 600000]'

# Un fichier déguisé (un PNG annoncé comme JPEG) est refusé.
upload 415 "$documents?kind=IDENTITY_FRONT" image/jpeg "$WORK/selfie.png" "$user_token"
# Taille maximale exacte : acceptée (elle remplace le recto). Un octet de plus : refusé par l'API.
upload 201 "$documents?kind=IDENTITY_FRONT" image/jpeg "$WORK/max.jpg" "$user_token"
check 'a file of exactly the maximum size is accepted and replaces the previous front' \
  '([.documents[].byteSize] | sort) == [300000, 5242880]'
upload 413 "$documents?kind=IDENTITY_FRONT" image/jpeg "$WORK/over.jpg" "$user_token"
check 'one byte more is refused by the API' \
  '.code == "PAYLOAD_TOO_LARGE" and (.detail | contains("5242880"))'
# Au-delà de la limite du proxy pour cette route : refusé par Nginx, dans le même format.
upload 413 "$documents?kind=IDENTITY_FRONT" image/jpeg "$WORK/huge.jpg" "$user_token"
check 'a much larger file is refused by the proxy, in the same error format' \
  '.code == "PAYLOAD_TOO_LARGE" and .detail == "The request body is too large."'
# Ailleurs, la limite générale du proxy s'applique toujours.
upload 413 /me/verification/identity application/json "$WORK/front.jpg" "$user_token"

request 200 POST "/me/verification/cases/$case_id/submit" '' "$user_token"
check 'the case is submitted' '.status == "SUBMITTED" and .submittedAt != null'
# Déposé, le dossier est figé : la déclaration ne se remplace plus.
request 409 PUT /me/verification/identity "$declaration" "$user_token"

request 200 GET '/admin/kyc/cases?limit=100' '' "$admin_token"
check 'the case waits in the review queue' "[.cases[].id] | index(\"$case_id\") != null"
request 200 GET "/admin/kyc/cases/$case_id" '' "$admin_token"
check 'the reviewer sees the full document number and both documents' \
  ".identity.document.number == \"$document_number\" and (.documents | length) == 2 and .user.id == \"$user_id\""
front_id="$(jq -r '.documents[] | select(.kind == "IDENTITY_FRONT") | .id' "$BODY")"
status="$(curl --silent --show-error --output "$WORK/downloaded.jpg" --dump-header "$HEADERS" --write-out '%{http_code} %{content_type}' \
  --header "Authorization: Bearer $admin_token" "$API/admin/kyc/cases/$case_id/documents/$front_id")"
pace
[ "$status" = "200 image/jpeg" ] || { echo "FAIL  document download -> $status" >&2; exit 1; }
cmp --silent "$WORK/max.jpg" "$WORK/downloaded.jpg" || { echo "FAIL  the downloaded document differs from the file sent" >&2; exit 1; }
echo "ok    the reviewer downloads the document, identical to the 5 MiB file sent"
request 200 POST "/admin/kyc/cases/$case_id/approve" '' "$admin_token"
check 'the case is approved' '.status == "APPROVED" and .decision.decidedBy.email != null'

request 200 GET /me '' "$user_token"
check 'the account is verified at level 1' '.verificationLevel == 1'
request 200 GET /me/profile '' "$user_token"
check 'the profile now carries the identity of the document, not the declared one' \
  '.identityVerified == true and .givenName == "Jean" and .familyName == "Mukendi" and .placeOfBirth == "Lubumbashi" and .timeZone == "Africa/Kinshasa"'
request 409 PATCH /me/profile '{"givenName": "Smoke"}' "$user_token"
request 200 GET /me/activity '' "$user_token"
check 'the activity shows the submission and the approval' \
  '[.entries[].type] | (index("IDENTITY_VERIFICATION_SUBMITTED") != null and index("IDENTITY_VERIFICATION_APPROVED") != null)'

# --- 6. Grand livre : un actif, un portefeuille à zéro, la balance -----------------------------
# Le parcours enregistre un actif, puis lit le portefeuille de l'utilisateur et la balance du
# grand livre. Un actif enregistré est définitif : son code est propre à cette exécution, pour
# que le script passe aussi sur une pile déjà utilisée.
asset_code="T$(date +%s)"
asset="$(jq -n --arg c "$asset_code" \
  '{code: $c, name: "Smoke test asset", kind: "FIAT", scale: 2, reason: "Smoke test of the containerised stack"}')"

request 200 GET /me/wallets '' "$user_token"
check 'an asset that is not registered is no wallet of the account' \
  "[.wallets[].asset.code] | index(\"$asset_code\") == null"
request 403 POST /admin/ledger/assets "$asset" "$user_token"
check 'an account holder cannot register an asset' '.code == "FORBIDDEN"'
request 201 POST /admin/ledger/assets "$asset" "$admin_token"
check 'the asset is registered with its two decimals, and names who registered it' \
  ".code == \"$asset_code\" and .kind == \"FIAT\" and .scale == 2 and .registeredBy != null and .registeredAt != null"
# Un actif ne s'enregistre qu'une fois.
request 409 POST /admin/ledger/assets "$asset" "$admin_token"

# Le titulaire dispose aussitôt d'un portefeuille dans cet actif : à zéro, sans mouvement.
request 200 GET /me/wallets '' "$user_token"
check 'the account now has an empty wallet in the asset, written with its two decimals' \
  "[.wallets[] | select(.asset.code == \"$asset_code\")] | length == 1 and .[0].available == \"0.00\" and .[0].asset.scale == 2"
request 200 GET "/me/wallets/$asset_code/movements" '' "$user_token"
check 'the wallet has no movement' \
  '.wallet.available == "0.00" and .movements == [] and .nextCursor == null'
request 404 GET /me/wallets/NOSUCHASSET/movements '' "$user_token"

# Vu du back-office : lire un portefeuille n'a ouvert aucun compte, et le grand livre est équilibré.
request 200 GET "/admin/ledger/accounts?assetCode=$asset_code" '' "$admin_token"
check 'no ledger account was opened' '.accounts == [] and .nextCursor == null'
request 200 GET /admin/ledger/trial-balance '' "$admin_token"
check 'the ledger is balanced, and holds nothing in the new asset' \
  ".balanced == true and ([.assets[] | select(.asset.code == \"$asset_code\")] | length == 1 and .[0].balanced == true and .[0].debitBalance == \"0.00\" and .[0].creditBalance == \"0.00\" and ([.[0].accountTypes[].accounts] | add) == 0)"

# --- 7. Transferts entre titulaires : fermés tant que rien n'est fixé, puis plafonnés ----------
# Le portefeuille est encore vide : cette partie vérifie ce qui précède un transfert — la
# fonctionnalité s'ouvre, les plafonds se fixent au back-office, niveau par niveau — et que
# chaque refus est le bon, sans qu'aucun fonds ne bouge. Le transfert lui-même vient après le
# premier crédit, à la partie suivante.
limits_path="/admin/transfer-limits/$asset_code/1"
# limits <par transfert> <sur 24 heures> <sur 31 jours> — corps d'un réglage des plafonds.
limits() {
  jq -n --arg t "$1" --arg d "$2" --arg m "$3" \
    '{perTransfer: $t, daily: $d, monthly: $m, reason: "Smoke test of the containerised stack"}'
}
# transfer <montant> [mot de passe] [destinataire] — corps d'une demande de transfert ; par
# défaut vers une adresse que nul ne porte : le destinataire n'est examiné qu'en dernier, et
# aucune des demandes de cette partie n'ira jusque-là.
transfer() {
  jq -n --arg r "${3:-nobody-$email}" --arg a "$asset_code" --arg m "$1" --arg p "${2:-$password}" \
    '{recipientEmail: $r, assetCode: $a, amount: $m, currentPassword: $p}'
}
# Une clé d'idempotence neuve : une demande refusée ne garde pas la sienne, mais chaque demande
# est ici une demande différente.
idempotency_key() {
  echo "Idempotency-Key: smoke-$(openssl rand -hex 12)"
}

request 200 PUT /admin/system-settings/features.internal_transfers \
  '{"value": true, "reason": "Smoke test of the containerised stack"}' "$admin_token"
# L'ouverture d'une fonctionnalité est visible en quelques secondes au plus sur chaque instance.
enabled=""
for _ in $(seq 1 20); do
  status="$(curl --silent --output "$BODY" --dump-header "$HEADERS" --write-out '%{http_code}' --header "Authorization: Bearer $user_token" "$API/me/transfer-limits")"
  pace
  enabled="$(jq -r '.enabled // false' "$BODY" 2>/dev/null || true)"
  [ "$status" = "200" ] && [ "$enabled" = "true" ] && break
  sleep 0.5
done
[ "$status" = "200" ] && [ "$enabled" = "true" ] || { echo "FAIL  GET /me/transfer-limits -> $status, enabled: $enabled" >&2; cat "$BODY" >&2; exit 1; }
echo "ok    GET /me/transfer-limits -> 200 (transfers between holders are open)"
check 'no limit is set in the new asset: the account, verified at level 1, can send nothing in it' \
  ".level == 1 and ([.allowances[] | select(.asset.code == \"$asset_code\")] | length == 1 and .[0].limit == null and .[0].remaining == \"0.00\")"
request 200 GET /admin/transfer-limits '' "$admin_token"
check 'the back office lists no limit for the new asset' \
  "[.limits[] | select(.asset.code == \"$asset_code\")] == []"

# Sans clé d'idempotence, aucune demande n'est examinée.
request 400 POST /me/transfers "$(transfer 25.00)" "$user_token"
check 'a transfer request must carry an idempotency key' \
  '.code == "VALIDATION_FAILED" and .errors[0].path == "Idempotency-Key"'
# Une session ouverte ne suffit pas : le mot de passe est redemandé.
request 401 POST /me/transfers "$(transfer 25.00 not-the-password-1)" "$user_token" "$(idempotency_key)"
# Fermé tant que rien n'est fixé : sans plafond pour son niveau, le compte n'envoie rien.
request 403 POST /me/transfers "$(transfer 25.00)" "$user_token" "$(idempotency_key)"
check 'without a limit for its level, the account cannot send the asset' '.code == "TRANSFER_NOT_PERMITTED"'

# Les plafonds se fixent au back-office — pas par un titulaire, et dans l'ordre.
request 403 PUT "$limits_path" "$(limits 100.00 250.00 1000.00)" "$user_token"
check 'an account holder cannot set the limits' '.code == "FORBIDDEN"'
request 400 PUT "$limits_path" "$(limits 100.00 50.00 1000.00)" "$admin_token"
check 'the limit over 24 hours cannot be lower than the limit per transfer' \
  '.code == "VALIDATION_FAILED" and .errors[0].path == "daily"'
request 400 PUT "$limits_path" "$(limits 100.00 250.00 1000.001)" "$admin_token"
check 'a limit has at most the decimals of the asset' \
  '.code == "VALIDATION_FAILED" and .errors[0].path == "monthly"'
request 200 PUT "$limits_path" "$(limits 100.00 250.00 1000.00)" "$admin_token"
check 'the limits of level 1 are set in the asset, and name who set them' \
  ".asset.code == \"$asset_code\" and .level == 1 and .perTransfer == \"100.00\" and .daily == \"250.00\" and .monthly == \"1000.00\" and .setBy != null and .setAt != null"
request 200 GET /admin/transfer-limits '' "$admin_token"
check 'the back office lists them: one level of the asset is open, the others are not' \
  "[.limits[] | select(.asset.code == \"$asset_code\") | .level] == [1]"

# L'effet est immédiat. Chaque refus pour sa raison : le plafond d'abord, puis le solde — le
# portefeuille est vide.
request 422 POST /me/transfers "$(transfer 100.01)" "$user_token" "$(idempotency_key)"
check 'an amount above the limit per transfer is refused' '.code == "TRANSFER_LIMIT_EXCEEDED"'
request 422 POST /me/transfers "$(transfer 100.00)" "$user_token" "$(idempotency_key)"
check 'an amount within the limits is refused for lack of funds' '.code == "INSUFFICIENT_FUNDS"'
request 400 POST /me/transfers "$(transfer 25.001)" "$user_token" "$(idempotency_key)"
check 'an amount has at most the decimals of the asset' \
  '.code == "VALIDATION_FAILED" and .errors[0].path == "amount"'

# Rien n'a bougé : aucun transfert, aucun compte ouvert dans le grand livre — le portefeuille est
# donc toujours vide —, et le titulaire lit ses plafonds, dont un transfert refusé n'entame rien.
# Il retrouve les refus dans son activité.
request 200 GET /me/transfers '' "$user_token"
check 'no transfer was made' '.transfers == [] and .nextCursor == null'
request 200 GET "/admin/ledger/accounts?assetCode=$asset_code" '' "$admin_token"
check 'the refusals opened no ledger account' '.accounts == []'
request 200 GET /me/transfer-limits '' "$user_token"
check 'the account reads its limits, and a refused transfer used nothing of them' \
  "[.allowances[] | select(.asset.code == \"$asset_code\")] | length == 1 and .[0].limit == {perTransfer: \"100.00\", daily: \"250.00\", monthly: \"1000.00\"} and .[0].used == {last24Hours: \"0.00\", last31Days: \"0.00\"} and .[0].remaining == \"100.00\""
request 200 GET /me/activity '' "$user_token"
check 'the activity shows the refused transfers and the failed proof' \
  '[.entries[].type] | (([.[] | select(. == "TRANSFER_REFUSED")] | length) == 3 and index("TRANSFER_FAILED") != null)'

# --- 8. Opérations du personnel : ajustements sous double validation, gel d'un portefeuille ----
adjustments=/admin/ledger/adjustments
freezes=/admin/ledger/wallet-freezes
# La justification d'un ajustement ou d'un gel reste interne : le parcours vérifie que le
# titulaire ne la lit nulle part. Aucune autre donnée du parcours ne contient ces mots.
staff_reason='Internal reason, never shown to the account holder'
# adjustment <sens> <montant> — corps d'une demande d'ajustement du portefeuille de l'utilisateur.
adjustment() {
  jq -n --arg u "$user_id" --arg a "$asset_code" --arg d "$1" --arg m "$2" --arg r "$staff_reason" \
    '{userId: $u, assetCode: $a, direction: $d, amount: $m, reason: $r}'
}
# proof <mot de passe> <fichier de codes de secours> — ce que présente de nouveau qui approuve :
# son mot de passe et son second facteur. Une session ouverte ne suffit pas.
proof() {
  jq -n --arg p "$1" --arg c "$(next_code "$2")" '{currentPassword: $p, recoveryCode: $c}'
}
close_account="$(jq -n --arg p "$password" '{currentPassword: $p, confirm: true}')"

# Fermés par défaut : pas même l'administrateur ne demande un ajustement. Sur une pile déjà
# utilisée, une exécution précédente les a laissés ouverts : ce contrôle-là est alors passé.
request 200 GET /system/status
if [ "$(jq -r .features.manualAdjustments "$BODY")" = "false" ]; then
  request 403 POST "$adjustments" "$(adjustment CREDIT 150.00)" "$admin_token"
  check 'manual adjustments are closed until an administrator opens them' '.code == "FEATURE_DISABLED"'
else
  echo "skip  manual adjustments are already open on this stack: their closed state is not exercised"
fi
request 403 POST "$adjustments" "$(adjustment CREDIT 150.00)" "$user_token"
check 'an account holder cannot request an adjustment' '.code == "FORBIDDEN"'
request 200 PUT /admin/system-settings/features.manual_adjustments \
  '{"value": true, "reason": "Smoke test of the containerised stack"}' "$admin_token"
# L'ouverture d'une fonctionnalité est visible en quelques secondes au plus sur chaque instance.
opened=""
for _ in $(seq 1 20); do
  curl --silent --output "$BODY" --dump-header "$HEADERS" "$API/system/status"
  pace
  opened="$(jq -r '.features.manualAdjustments // false' "$BODY" 2>/dev/null || true)"
  [ "$opened" = "true" ] && break
  sleep 0.5
done
[ "$opened" = "true" ] || { echo "FAIL  manual adjustments were not opened" >&2; cat "$BODY" >&2; exit 1; }
echo "ok    GET /system/status -> manual adjustments are open"

# Une demande ne déplace rien ; une demande identique ne se dépose pas deux fois.
request 201 POST "$adjustments" "$(adjustment CREDIT 150.00)" "$admin_token"
adjustment_id="$(jq -r .id "$BODY")"
check 'the request is pending: nothing moves until a second member of staff approves it' \
  ".status == \"PENDING\" and .direction == \"CREDIT\" and .amount == \"150.00\" and .user.id == \"$user_id\" and .entryId == null and .decidedBy == null and .expiresAt != null"
request 409 POST "$adjustments" "$(adjustment CREDIT 150.0)" "$admin_token"
check 'one identical request at most can be pending' '.code == "CONFLICT"'
request 422 POST "$adjustments" "$(adjustment DEBIT 0.01)" "$admin_token"
check 'a debit the wallet does not cover is refused at once' '.code == "INSUFFICIENT_FUNDS"'
request 200 GET "/me/wallets/$asset_code/movements" '' "$user_token"
check 'the wallet is still empty' '.wallet.available == "0.00" and .wallet.frozen == false and .movements == []'
# Approuver exige une preuve ; et son auteur n'approuve pas sa propre demande, même avec elle.
request 400 POST "$adjustments/$adjustment_id/approve" '{}' "$admin_token"
request 403 POST "$adjustments/$adjustment_id/approve" "$(proof "$MGX_ADMIN_PASSWORD" "$WORK/codes-1")" "$admin_token"
check 'the author of a request cannot approve it' '.code == "FORBIDDEN"'

dual_approval=no
if [ -z "$second_admin_email" ]; then
  echo "skip  no second administrator (SECOND_ADMIN_EMAIL): dual approval, the transfer and the debit are not exercised"
  request 200 POST "$adjustments/$adjustment_id/cancel" '' "$admin_token"
  check 'its author withdraws the request' '.status == "CANCELLED" and .entryId == null'
else
  dual_approval=yes
  # Le second administrateur active sa validation en deux étapes, comme le premier.
  second_credentials="$(jq -n --arg e "$second_admin_email" --arg p "$second_admin_password" '{email: $e, password: $p}')"
  request 200 POST /auth/login "$second_credentials"
  if [ "$(jq -r .status "$BODY")" != "AUTHENTICATED" ]; then
    echo "FAIL  the second administrator already has two-step verification: create a fresh one (admin:create)" >&2
    exit 1
  fi
  second_token="$(jq -r .tokens.accessToken "$BODY")"
  request 200 POST /me/mfa/totp/enroll "$(jq -n --arg p "$second_admin_password" '{currentPassword: $p}')" "$second_token"
  second_secret="$(jq -r .secret "$BODY")"
  request 200 POST /me/mfa/totp/confirm "$(jq -n --arg c "$(totp "$second_secret")" '{code: $c}')" "$second_token"
  jq -r '.recoveryCodes[]' "$BODY" > "$WORK/codes-2"

  # Sans le bon mot de passe, rien n'est examiné ; avec sa preuve, la demande est approuvée et
  # l'écriture passée — une seule fois.
  request 401 POST "$adjustments/$adjustment_id/approve" "$(proof not-the-password-1 "$WORK/codes-2")" "$second_token"
  request 200 POST "$adjustments/$adjustment_id/approve" "$(proof "$second_admin_password" "$WORK/codes-2")" "$second_token"
  check 'a second administrator approves the request: its ledger entry is posted' \
    ".status == \"APPROVED\" and .decidedBy.email == \"$second_admin_email\" and .requestedBy.email == \"$ADMIN_EMAIL\" and .entryId != null"
  entry_id="$(jq -r .entryId "$BODY")"
  request 409 POST "$adjustments/$adjustment_id/approve" "$(proof "$second_admin_password" "$WORK/codes-2")" "$second_token"
  request 200 GET "/me/wallets/$asset_code/movements" '' "$user_token"
  check 'the wallet is credited, by a movement that names the adjustment' \
    '.wallet.available == "150.00" and (.movements | length) == 1 and .movements[0].kind == "adjustment.credit" and .movements[0].side == "CREDIT" and .movements[0].amount == "150.00" and .movements[0].balanceAfter == "150.00"'
  request 200 GET "/admin/ledger/entries/$entry_id" '' "$admin_token"
  check 'the entry debits the custody account of the platform and credits the wallet' \
    '.kind == "adjustment.credit" and [.postings[] | [.account.type, .side, .amount]] == [["platform_custody", "DEBIT", "150.00"], ["user_available", "CREDIT", "150.00"]]'
  # Le titulaire est prévenu — sans la raison.
  told=""
  for _ in $(seq 1 60); do
    curl --silent --output "$BODY" --dump-header "$HEADERS" "$API/dev/mailbox?recipient=$email"
    pace
    told="$(jq -r '[.messages[] | select(.template == "wallet_adjusted")] | length' "$BODY")"
    [ "$told" = "1" ] && break
    sleep 0.5
  done
  [ "$told" = "1" ] || { echo "FAIL  no adjustment notice received" >&2; cat "$BODY" >&2; exit 1; }
  check 'the holder is told of the credit, never of its reason' \
    '[.messages[] | select(.template == "wallet_adjusted")][0].text | (contains("150.00") and (contains("Internal reason") | not))'

  # Un vrai transfert. Le destinataire est un compte neuf, sans dossier de vérification : le
  # niveau 0 est ouvert dans l'actif, comme peut le décider la plateforme.
  recipient_email="recipient-$email"
  request 202 POST /auth/register "$(jq -n --arg e "$recipient_email" --arg p "$password" --argjson v "$((terms_version + 1))" \
    '{email: $e, password: $p, countryCode: "CD", acceptedTermsVersion: $v}')"
  code=""
  for _ in $(seq 1 60); do
    curl --silent --output "$BODY" --dump-header "$HEADERS" "$API/dev/mailbox?recipient=$recipient_email"
    pace
    code="$(jq -r '.messages[0].text // ""' "$BODY" | grep -oE '\b[0-9]{6}\b' | head -n 1 || true)"
    [ -n "$code" ] && break
    sleep 0.5
  done
  [ -n "$code" ] || { echo "FAIL  no verification code received by the recipient" >&2; exit 1; }
  request 204 POST /auth/email/verify "$(jq -n --arg e "$recipient_email" --arg c "$code" --arg p "$password" '{email: $e, code: $c, password: $p}')"
  # Tant que son niveau n'est pas ouvert dans l'actif, le destinataire ne reçoit rien.
  request 422 POST /me/transfers "$(transfer 40.00 "$password" "$recipient_email")" "$user_token" "$(idempotency_key)"
  check 'a recipient whose level is not open cannot receive' '.code == "RECIPIENT_UNAVAILABLE"'
  request 200 PUT "/admin/transfer-limits/$asset_code/0" "$(limits 100.00 250.00 1000.00)" "$admin_token"

  key="$(idempotency_key)"
  request 201 POST /me/transfers "$(transfer 40.00 "$password" "$recipient_email")" "$user_token" "$key"
  check 'the transfer is made, at once' \
    ".direction == \"SENT\" and .amount == \"40.00\" and .counterparty.email == \"$recipient_email\" and .entryId != null"
  transfer_id="$(jq -r .id "$BODY")"
  [ -z "$(header Idempotent-Replayed)" ] || { echo "FAIL  a first transfer is not a replay" >&2; exit 1; }
  # La même requête renvoyée sous la même clé : le même transfert, et rien de plus.
  request 201 POST /me/transfers "$(transfer 40.0 "$password" "$recipient_email")" "$user_token" "$key"
  check 'sent again under the same key, the request answers with the original transfer' ".id == \"$transfer_id\""
  [ "$(header Idempotent-Replayed)" = "true" ] || { echo "FAIL  the replayed transfer does not say so" >&2; exit 1; }
  echo "ok    the replay is announced (Idempotent-Replayed: true)"
  request 422 POST /me/transfers "$(transfer 41.00 "$password" "$recipient_email")" "$user_token" "$key"
  check 'another request under the same key is refused' '.code == "IDEMPOTENCY_KEY_REUSED"'
  # Au centime près : 150 crédités, 40 envois — une fois.
  request 200 GET "/admin/ledger/accounts?assetCode=$asset_code" '' "$admin_token"
  check 'the ledger holds what was credited, where the transfer left it' \
    '([.accounts[] | [.type, .balance]] | sort) == [["platform_custody", "150.00"], ["user_available", "110.00"], ["user_available", "40.00"]]'
  request 200 GET /admin/ledger/trial-balance '' "$admin_token"
  check 'the ledger is balanced: what the platform holds is what it owes' \
    ".balanced == true and ([.assets[] | select(.asset.code == \"$asset_code\")] | .[0].debitBalance == \"150.00\" and .[0].creditBalance == \"150.00\")"
fi

# Geler le portefeuille : plus rien n'en part, et le compte ne se clôt pas.
freeze="$(jq -n --arg u "$user_id" --arg a "$asset_code" --arg r "$staff_reason" '{userId: $u, assetCode: $a, reason: $r}')"
request 403 POST "$freezes" "$freeze" "$user_token"
request 201 POST "$freezes" "$freeze" "$admin_token"
freeze_id="$(jq -r .id "$BODY")"
check 'the wallet is frozen' ".status == \"ACTIVE\" and .userId == \"$user_id\" and .liftedAt == null"
request 409 POST "$freezes" "$freeze" "$admin_token"
request 200 GET /me/wallets '' "$user_token"
check 'the holder sees the wallet frozen — never why' \
  "([.wallets[] | select(.asset.code == \"$asset_code\")] | .[0].frozen == true) and (tostring | contains(\"Internal reason\") | not)"
request 403 POST /me/transfers "$(transfer 1.00)" "$user_token" "$(idempotency_key)"
check 'nothing leaves a frozen wallet' '.code == "WALLET_FROZEN"'

if [ "$dual_approval" = yes ]; then
  # Un débit sous double validation en sort pourtant le solde — demandé par l'un, approuvé par
  # l'autre : les rôles sont inversés.
  request 201 POST "$adjustments" "$(adjustment DEBIT 110.00)" "$second_token"
  debit_id="$(jq -r .id "$BODY")"
  request 200 POST "$adjustments/$debit_id/approve" "$(proof "$MGX_ADMIN_PASSWORD" "$WORK/codes-1")" "$admin_token"
  check 'a debit under dual approval leaves the frozen wallet' \
    ".status == \"APPROVED\" and .direction == \"DEBIT\" and .decidedBy.email == \"$ADMIN_EMAIL\""
  request 200 GET "/me/wallets/$asset_code/movements" '' "$user_token"
  check 'the wallet is empty again, and tells its three movements' \
    '.wallet.available == "0.00" and .wallet.frozen == true and [.movements[].kind] == ["adjustment.debit", "transfer.internal", "adjustment.credit"]'
fi

request 409 POST /me/close "$close_account" "$user_token"
check 'an account with a frozen wallet cannot be closed' '.detail | contains("frozen")'
request 400 POST "$freezes/$freeze_id/lift" '{}' "$admin_token"
request 200 POST "$freezes/$freeze_id/lift" "$(jq -n --arg r "$staff_reason" '{reason: $r}')" "$admin_token"
check 'the freeze is lifted, and remains as its record' '.status == "LIFTED" and .liftedBy != null and .liftReason != null'
request 200 GET "$freezes?userId=$user_id" '' "$admin_token"
check 'the back office lists the freeze' "[.freezes[] | [.id, .status]] == [[\"$freeze_id\", \"LIFTED\"]]"
request 200 GET "$adjustments?userId=$user_id" '' "$admin_token"
if [ "$dual_approval" = yes ]; then
  check 'the back office lists both adjustments, most recent first' '[.adjustments[] | [.direction, .status]] == [["DEBIT", "APPROVED"], ["CREDIT", "APPROVED"]]'
else
  check 'the back office lists the withdrawn request' '[.adjustments[] | [.direction, .status]] == [["CREDIT", "CANCELLED"]]'
fi
request 200 GET '/me/activity?limit=50' '' "$user_token"
check 'the activity never tells why the platform acted on the wallet' 'tostring | contains("Internal reason") | not'
if [ "$dual_approval" = yes ]; then
  check 'the activity shows what the platform did to the wallet, and the transfer' \
    '[.entries[].type] | (index("WALLET_CREDITED") != null and index("WALLET_DEBITED") != null and index("WALLET_FROZEN") != null and index("WALLET_UNFROZEN") != null and index("TRANSFER_SENT") != null)'
else
  check 'the activity shows the freeze and its lifting' \
    '[.entries[].type] | (index("WALLET_FROZEN") != null and index("WALLET_UNFROZEN") != null and index("WALLET_CREDITED") == null)'
fi

# --- 9. Back-office des comptes ------------------------------------------------------------------
request 200 POST /admin/users/search "$(jq -n --arg e "$email" '{email: $e}')" "$admin_token"
check 'the back office finds the account by its address' ".users | length == 1 and .[0].id == \"$user_id\""
request 200 GET '/admin/users?limit=5' '' "$admin_token"
check 'the back office lists accounts' '.users | length >= 2'
request 200 POST "/admin/users/$user_id/sessions/revoke" \
  '{"reason": "Smoke test of the containerised stack"}' "$admin_token"
check 'the sessions of the account are closed' '.revokedSessions >= 1'
request 401 GET /me '' "$user_token"

# --- 10. Copie des données, puis clôture du compte ---------------------------------------------
request 200 POST /auth/login "$credentials"
user_token="$(jq -r .tokens.accessToken "$BODY")"
holder_proof="$(jq -n --arg p "$password" '{currentPassword: $p}')"
# Une session ouverte ne suffit pas : le mot de passe est redemandé.
request 400 POST /me/data-export '{}' "$user_token"
request 401 POST /me/data-export '{"currentPassword": "not-the-password-1"}' "$user_token"
request 200 POST /me/data-export "$holder_proof" "$user_token"
check 'the copy holds the account, its verified identity and its history' \
  ".formatVersion == 5 and .account.email == \"$email\" and .verification.level == 1 and (.verification.cases | length) == 1 and (.activity.entries | length) > 0 and ([.terms.acceptances[].version] == [$((terms_version + 1)), $terms_version])"
if [ "$dual_approval" = yes ]; then
  check 'the copy holds the wallet — empty, no longer frozen —, its three movements and the transfer' \
    ".wallets | length == 1 and .[0].asset.code == \"$asset_code\" and .[0].available == \"0.00\" and .[0].frozen == false and (.[0].movements | length) == 3"
  check 'the copy holds the transfer that was sent' \
    ".transfers.truncated == false and (.transfers.items | length) == 1 and .transfers.items[0].id == \"$transfer_id\" and .transfers.items[0].amount == \"40.00\""
else
  check 'the copy holds no wallet nor transfer, no movement having been made' \
    '.wallets == [] and .transfers == {items: [], truncated: false}'
fi
check 'the copy never tells why the platform acted on the wallet' 'tostring | contains("Internal reason") | not'
check 'the copy never holds the full number of the identity document' \
  "tostring | contains(\"$document_number\") | not"

# La clôture est définitive : elle exige la confirmation, en plus du mot de passe.
request 400 POST /me/close "$holder_proof" "$user_token"
request 200 POST /me/close "$close_account" "$user_token"
check 'the account is closed, and its verification records are retained by law' \
  '.closedAt != null and .legalRetentionUntil != null and .erasureDueAt == .legalRetentionUntil'
request 401 GET /me '' "$user_token"
request 401 POST /auth/login "$credentials"
check 'a closed account no longer exists for sign-in' '.code == "INVALID_CREDENTIALS"'

# Le titulaire est prévenu à l'adresse que portait le compte.
notice=""
for _ in $(seq 1 60); do
  curl --silent --output "$BODY" --dump-header "$HEADERS" "$API/dev/mailbox?recipient=$email"
  pace
  notice="$(jq -r '[.messages[] | select(.template == "account_closed")] | length' "$BODY")"
  [ "$notice" = "1" ] && break
  sleep 0.5
done
[ "$notice" = "1" ] || { echo "FAIL  no closure notice received" >&2; cat "$BODY" >&2; exit 1; }
echo "ok    closure notice received at the former address"

# Le back-office retrouve le compte clôturé par son ancienne adresse ; le dossier est conservé.
request 200 POST /admin/users/search "$(jq -n --arg e "$email" '{email: $e}')" "$admin_token"
check 'the back office finds the closed account by its former address' \
  ".users | length == 1 and .[0].id == \"$user_id\" and .[0].status == \"CLOSED\""
request 200 GET "/admin/users/$user_id" '' "$admin_token"
check 'the account sheet tells how the account was closed, and carries no identifier' \
  ".closure.origin == \"HOLDER\" and .closure.formerEmail == \"$email\" and .closure.erasedAt == null and .email == \"closed-$user_id@closed.invalid\" and .activeSessions == 0"
request 200 GET "/admin/kyc/cases/$case_id" '' "$admin_token"
check 'the approved case is kept, ended by the closure' '.status == "ACCOUNT_CLOSED"'
request 409 POST "/admin/users/$user_id/suspend" '{"reason": "Smoke test of the containerised stack"}' "$admin_token"

request 200 GET /admin/roles '' "$admin_token"
check 'system roles are in place' '[.roles[].key] == ["compliance", "super_admin", "support"]'
request 204 POST /auth/logout '' "$admin_token"
request 401 GET /me '' "$admin_token"

echo "info  $REQUESTS requests answered by the API; $COUNTED counted by its general rate limit (${RATE_LIMIT:-?} per window, lowest remaining announced: ${LOWEST:-?}); $PAUSES pause(s)"
echo "Identity smoke test passed (dual approval and a completed transfer exercised: $dual_approval)."
