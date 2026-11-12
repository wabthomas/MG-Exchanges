import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { TOTP_PARAMETERS } from '@mgx/contracts';

/**
 * Codes du second facteur : TOTP (RFC 6238) sur HOTP (RFC 4226), avec les paramètres que
 * toutes les applications d'authentification acceptent — HMAC-SHA-1, six chiffres, trente
 * secondes. Aucune dépendance : l'algorithme tient en quelques lignes et se vérifie contre les
 * vecteurs de test des deux RFC.
 */

/** Taille du secret : 160 bits, la taille recommandée par la RFC 4226 pour HMAC-SHA-1. */
export const TOTP_SECRET_BYTES = 20;

/** Nombre de pas de temps tolérés de part et d'autre du pas courant (décalage d'horloge). */
export const TOTP_STEP_TOLERANCE = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) sans remplissage : la forme attendue par les applications d'authentification. */
export function base32Encode(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET.charAt((buffer >>> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    output += BASE32_ALPHABET.charAt((buffer << (5 - bits)) & 31);
  }
  return output;
}

/** Décode une chaîne base32 (casse et remplissage indifférents), ou `null` si elle est invalide. */
export function base32Decode(text: string): Buffer | null {
  const normalized = text.toUpperCase().replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value === -1) {
      return null;
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
    buffer &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** HOTP (RFC 4226) : code du compteur donné. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits: number = TOTP_PARAMETERS.digits,
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  // Troncature dynamique : les quatre bits de poids faible désignent quatre octets du HMAC.
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fff_ffff;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** Numéro du pas de temps (trente secondes) contenant `now`. */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PARAMETERS.periodSeconds);
}

/**
 * Pas de temps dont le code est `code`, parmi le pas courant et ses voisins immédiats, et
 * **strictement postérieur** à `afterStep` (dernier pas déjà accepté) ; `null` sinon.
 *
 * Un code n'est accepté qu'une fois (RFC 6238, § 5.2) : rejouer un code intercepté, même
 * dans sa fenêtre de validité, échoue.
 */
export function matchTotpStep(
  secret: Uint8Array,
  code: string,
  now: Date,
  afterStep: number | null,
): number | null {
  const presented = Buffer.from(code, 'utf8');
  const current = totpStep(now);
  let matched: number | null = null;
  // Tous les pas sont évalués, sans sortie anticipée : la durée ne dit pas lequel correspond.
  for (let step = current - TOTP_STEP_TOLERANCE; step <= current + TOTP_STEP_TOLERANCE; step += 1) {
    if (step < 0) {
      continue;
    }
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    const equal = expected.length === presented.length && timingSafeEqual(expected, presented);
    if (equal && matched === null && (afterStep === null || step > afterStep)) {
      matched = step;
    }
  }
  return matched;
}

/**
 * URI `otpauth://` (format « Key URI » des applications d'authentification), à présenter
 * sous forme de QR code par le client.
 */
export function otpauthUri(parameters: {
  readonly issuer: string;
  readonly accountName: string;
  readonly secret: Uint8Array;
}): string {
  const label = `${encodeURIComponent(parameters.issuer)}:${encodeURIComponent(parameters.accountName)}`;
  const query = [
    `secret=${base32Encode(parameters.secret)}`,
    `issuer=${encodeURIComponent(parameters.issuer)}`,
    `algorithm=${TOTP_PARAMETERS.algorithm}`,
    `digits=${TOTP_PARAMETERS.digits}`,
    `period=${TOTP_PARAMETERS.periodSeconds}`,
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}
