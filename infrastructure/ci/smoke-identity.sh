#!/usr/bin/env bash
# Parcours d'identité de bout en bout, à travers le reverse proxy, sur une pile démarrée :
# connexion d'un administrateur, ouverture de l'inscription, inscription d'un utilisateur,
# code reçu dans la boîte de développement, vérification, connexion, contrôle des droits.
#
# Prérequis : un compte administrateur créé au préalable avec l'outil en ligne de commande
# (`admin:create`), et la remise des notifications en mémoire (environnement local).
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

request 401 GET /me
request 200 POST /auth/login "$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$MGX_ADMIN_PASSWORD" '{email: $e, password: $p}')"
admin_token="$(jq -r .tokens.accessToken "$BODY")"
jq -e '.user.roles == ["super_admin"]' "$BODY" >/dev/null

request 200 PUT /admin/system-settings/features.registration \
  '{"value": true, "reason": "Smoke test of the containerised stack"}' "$admin_token"

email="smoke-$(date +%s)-$RANDOM@example.cd"
password="smoke-test-$(openssl rand -hex 8)"
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

request 403 POST /auth/login "$(jq -n --arg e "$email" --arg p "$password" '{email: $e, password: $p}')"
request 204 POST /auth/email/verify "$(jq -n --arg e "$email" --arg c "$code" '{email: $e, code: $c}')"
request 200 POST /auth/login "$(jq -n --arg e "$email" --arg p "$password" '{email: $e, password: $p}')"
user_token="$(jq -r .tokens.accessToken "$BODY")"
refresh_token="$(jq -r .tokens.refreshToken "$BODY")"

request 200 GET /me '' "$user_token"
jq -e --arg e "$email" '.email == $e and .status == "ACTIVE" and .permissions == []' "$BODY" >/dev/null
request 403 GET /admin/system-settings '' "$user_token"
request 200 POST /auth/refresh "$(jq -n --arg t "$refresh_token" '{refreshToken: $t}')"
request 204 POST /auth/logout '' "$user_token"
request 401 GET /me '' "$user_token"

echo "Identity smoke test passed."
