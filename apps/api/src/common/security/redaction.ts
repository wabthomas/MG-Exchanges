/** Valeur de remplacement des données sensibles dans les journaux et le journal d'audit. */
export const REDACTED = '[REDACTED]';

/** Marqueurs recherchés n'importe où dans le nom d'une clé (après normalisation). */
const SENSITIVE_FRAGMENTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'mnemonic',
  'credential',
  'cardnumber',
  'sessionid',
  'signature',
] as const;

/** Mots courts, ambigus en sous-chaîne (« pin » dans « shipping ») : comparés mot à mot. */
const SENSITIVE_WORDS = new Set(['pin', 'otp', 'cvv', 'cvc', 'pan', 'seed', 'pwd']);

const BEARER_PATTERN = /^Bearer\s+\S+/i;
const JWT_PATTERN = /^eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*$/;

const MAX_DEPTH = 8;

/** Indique si le nom d'une clé désigne une donnée secrète (`password`, `accessToken`, `otp`…). */
export function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  const joined = words.join('');

  return (
    SENSITIVE_FRAGMENTS.some((fragment) => joined.includes(fragment)) ||
    words.some((word) => SENSITIVE_WORDS.has(word))
  );
}

function looksLikeCredential(value: string): boolean {
  return BEARER_PATTERN.test(value) || JWT_PATTERN.test(value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Copie profonde de `value` où toute donnée sensible est remplacée par {@link REDACTED} :
 * valeurs des clés au nom sensible, jetons « Bearer » et JWT où qu'ils se trouvent.
 *
 * Seuls les objets simples et les tableaux sont parcourus ; les autres instances
 * (erreurs, requêtes HTTP, dates…) sont laissées telles quelles à leurs sérialiseurs.
 */
export function redactSensitive<T>(value: T): T {
  return redact(value, 0, new WeakSet()) as T;
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return looksLikeCredential(value) ? REDACTED : value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return value;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  if (depth >= MAX_DEPTH) {
    return '[TRUNCATED]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return copy;
}
