#!/usr/bin/env bash
# Parcours d'identité de bout en bout, à travers le reverse proxy, sur une pile démarrée :
#
#   1. l'administrateur se connecte ; le back-office lui est fermé tant qu'il n'a pas activé la
#      validation en deux étapes ; il l'active (secret TOTP, premier code, codes de secours) ;
#   2. il ouvre l'inscription ;
#   3. un utilisateur s'inscrit, reçoit son code dans la boîte de développement, vérifie son
#      adresse avec son mot de passe, se connecte, consulte son compte, n'a aucun droit
#      d'administration, renouvelle sa session, complète son profil ;
#   4. l'administrateur se reconnecte en deux étapes (code de secours) ;
#   5. vérification d'identité : l'administrateur ouvre la fonctionnalité ; l'utilisateur déclare
#      son identité, envoie ses pièces — des fichiers de plusieurs centaines de kilo-octets, puis
#      de la taille maximale, à travers le proxy —, dépose son dossier ; l'administrateur le
#      trouve dans la file, relit une pièce à l'identique et accepte le dossier ; le compte est
#      vérifié et son profil reprend l'identité de la pièce ;
#   6. l'administrateur retrouve le compte par son adresse et ferme ses sessions.
#
# Prérequis :
#   - un compte administrateur NEUF, créé avec l'outil en ligne de commande (`admin:create`) :
#     le script active son second facteur et n'en conserve pas le secret, il ne peut donc pas
#     être rejoué avec le même compte ;
#   - la remise des notifications en mémoire (environnement local) ;
#   - le stockage chiffré des pièces configuré (KYC_ENCRYPTION_KEY) ;
#   - curl, jq, openssl et python3 (calcul du code TOTP, dates).
#
#   BASE_URL=http://127.0.0.1:8080 ADMIN_EMAIL=… MGX_ADMIN_PASSWORD=… ./smoke-identity.sh
set -euo pipefail

: "${BASE_URL:?}" "${ADMIN_EMAIL:?}" "${MGX_ADMIN_PASSWORD:?}"
API="$BASE_URL/api/v1"
BODY="$(mktemp)"
WORK="$(mktemp -d)"
trap 'rm -rf "$BODY" "$WORK"' EXIT

# request <statut attendu> <méthode> <chemin> [corps JSON] [jeton] — le corps de la réponse est dans $BODY.
request() {
  local expected="$1" method="$2" path="$3" data="${4:-}" token="${5:-}" status
  local -a args=(--silent --show-error --output "$BODY" --write-out '%{http_code}' --request "$method")
  [ -n "$data" ] && args+=(--header 'Content-Type: application/json' --data "$data")
  [ -n "$token" ] && args+=(--header "Authorization: Bearer $token")
  # Un échec de curl ne doit pas interrompre le script sans explication : le statut reçu
  # (000 s'il n'y en a pas eu) est comparé à celui qui est attendu.
  status="$(curl "${args[@]}" "$API$path")" || true
  if [ "$status" != "$expected" ]; then
    echo "FAIL  $method $path -> $status (expected $expected)" >&2
    cat "$BODY" >&2
    exit 1
  fi
  echo "ok    $method $path -> $status"
}

# upload <statut attendu> <chemin> <type de contenu> <fichier> [jeton] — envoie le fichier
# lui-même comme corps de la requête ; le corps de la réponse est dans $BODY.
upload() {
  local expected="$1" path="$2" content_type="$3" file="$4" token="${5:-}" status
  local -a args=(--silent --show-error --output "$BODY" --write-out '%{http_code}' --request POST
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

admin_credentials="$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$MGX_ADMIN_PASSWORD" '{email: $e, password: $p}')"

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
recovery_code="$(jq -r '.recoveryCodes[0]' "$BODY")"

# --- 2. Ouverture de l'inscription ---------------------------------------------------------------
request 200 PUT /admin/system-settings/features.registration \
  '{"value": true, "reason": "Smoke test of the containerised stack"}' "$admin_token"

# --- 3. Utilisateur ----------------------------------------------------------------------------
email="smoke-$(date +%s)-$RANDOM@example.cd"
password="smoke-test-$(openssl rand -hex 8)"
credentials="$(jq -n --arg e "$email" --arg p "$password" '{email: $e, password: $p}')"
# L'ouverture d'une fonctionnalité est visible en quelques secondes au plus sur chaque instance.
for _ in $(seq 1 20); do
  status="$(curl --silent --output "$BODY" --write-out '%{http_code}' --header 'Content-Type: application/json' \
    --data "$(jq -n --arg e "$email" --arg p "$password" '{email: $e, password: $p, countryCode: "CD", acceptTerms: true}')" \
    "$API/auth/register")"
  [ "$status" = "202" ] && break
  sleep 0.5
done
[ "$status" = "202" ] || { echo "FAIL  POST /auth/register -> $status" >&2; cat "$BODY" >&2; exit 1; }
echo "ok    POST /auth/register -> 202"

# Le code est émis par un traitement asynchrone (boîte d'envoi, puis file de traitement).
code=""
for _ in $(seq 1 60); do
  curl --silent --output "$BODY" "$API/dev/mailbox?recipient=$email"
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

# --- 5. Vérification d'identité, pièces comprises, à travers le proxy ---------------------------
request 200 PUT /admin/system-settings/features.kyc \
  '{"value": true, "reason": "Smoke test of the containerised stack"}' "$admin_token"
# L'ouverture d'une fonctionnalité est visible en quelques secondes au plus sur chaque instance.
for _ in $(seq 1 20); do
  status="$(curl --silent --output "$BODY" --write-out '%{http_code}' --header "Authorization: Bearer $user_token" "$API/me/verification")"
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
status="$(curl --silent --show-error --output "$WORK/downloaded.jpg" --write-out '%{http_code} %{content_type}' \
  --header "Authorization: Bearer $admin_token" "$API/admin/kyc/cases/$case_id/documents/$front_id")"
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

# --- 6. Back-office des comptes ------------------------------------------------------------------
request 200 POST /admin/users/search "$(jq -n --arg e "$email" '{email: $e}')" "$admin_token"
check 'the back office finds the account by its address' ".users | length == 1 and .[0].id == \"$user_id\""
request 200 GET '/admin/users?limit=5' '' "$admin_token"
check 'the back office lists accounts' '.users | length >= 2'
request 200 POST "/admin/users/$user_id/sessions/revoke" \
  '{"reason": "Smoke test of the containerised stack"}' "$admin_token"
check 'the sessions of the account are closed' '.revokedSessions >= 1'
request 401 GET /me '' "$user_token"
request 200 GET /admin/roles '' "$admin_token"
check 'system roles are in place' '[.roles[].key] == ["compliance", "super_admin", "support"]'
request 204 POST /auth/logout '' "$admin_token"
request 401 GET /me '' "$admin_token"

echo "Identity smoke test passed."
