import type { Prisma } from '../generated/prisma/client.js';

/**
 * Convertit un objet en JSON strict (aller-retour de sérialisation) avant stockage :
 * les `undefined` disparaissent, les dates deviennent des chaînes ISO 8601.
 */
export function toJsonObject(value: Readonly<Record<string, unknown>>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
