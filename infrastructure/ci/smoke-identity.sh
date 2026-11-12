#!/usr/bin/env bash
# Parcours d'identité de bout en bout, à travers le reverse proxy, sur une pile démarrée :
#
#   1. l'administrateur se connecte ; le back-office lui est fermé tant qu'il n'a pas activé la
#      validation en deux étapes ; il l'active (secret TOTP, premier code, codes de secours) ;
#   2. il ouvre l'inscription ;
#   3. un utilisateur s'inscrit, reçoit son code dans la boîte de développement, vérifie son
#      adresse avec son mot de passe, se connecte, consulte son compte, n'a aucun droit
#      d'administration, renouvelle sa session, complète son profil ;
#   4. l'administrateur se reconnecte en deux étapes (code de secours), retrouve le compte par
#      son adresse et ferme ses sessions.
#
# Prérequis :
#   - un compte administrateur NEUF, créé avec l'outil en ligne de commande (`admin:create`) :
#     le script active son second facteur et n'en conserve pas le secret, il ne peut donc pas
#     être rejoué avec le même compte ;
#   - la remise des notifications en mémoire (environnement local) ;
#   - curl, jq, openssl et python3 (calcul du code TOTP).
#
#   BASE_URL=http://127.0.0.1:8080 ADMIN_EMAIL=… MGX_ADMIN_PASSWORD=… ./smoke-identity.sh
set -euo pipefail

: "${BASE_URL:?}" "${ADMIN_EMAIL:?}" "${MGX_ADMIN_PASSWORD:?}"
API="$BASE_URL/api/v1"
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

# request <statut attendu> <méthode> <chemin> [corps JSON] [jeton] — le corps de la réponse est dans $BODY.
request() {
  local expected="$1" method="$2" path="$3" data="${4:-}" token="${5:-}" status
  local -a args=(--silent --show-error --output "$BODY" --write-out '%{http_code}' --request "$method")
  [ -n "$data" ] && args+=(--header 'Content-Type: application/json' --data "$data")
  [ -n "$token" ] && args+=(--header "Authorization: Bearer $token")
  status="$(curl "${args[@]}" "$API$path")"
  if [ "$status" != "$expected" ]; then
    echo "FAIL  $method $path -> $status (expected $expected)" >&2
    cat "$BODY" >&2
    exit 1
  fi
  echo "ok    $method $path -> $status"
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

request 200 POST /admin/users/search "$(jq -n --arg e "$email" '{email: $e}')" "$admin_token"
check 'the back office finds the account by its address' ".users | length == 1 and .[0].id == \"$user_id\""
request 200 GET '/admin/users?limit=5' '' "$admin_token"
check 'the back office lists accounts' '.users | length >= 2'
request 200 POST "/admin/users/$user_id/sessions/revoke" \
  '{"reason": "Smoke test of the containerised stack"}' "$admin_token"
check 'the sessions of the account are closed' '.revokedSessions >= 1'
request 401 GET /me '' "$user_token"
request 200 GET /admin/roles '' "$admin_token"
check 'system roles are in place' '[.roles[].key] == ["super_admin", "support"]'
request 204 POST /auth/logout '' "$admin_token"
request 401 GET /me '' "$admin_token"

echo "Identity smoke test passed."
