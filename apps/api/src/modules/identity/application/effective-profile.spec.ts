import { describe, expect, it } from '@jest/globals';

import { verifiedLevelOf } from '../domain/verification-level.js';
import {
  ADDRESS_PROFILE_FIELDS,
  effectiveProfileOf,
  IDENTITY_PROFILE_FIELDS,
  lockedProfileFields,
} from './effective-profile.js';
import { MaintenanceStepRegistry } from './maintenance-step.registry.js';
import type { ProfileRecord } from './profile.repository.js';
import type { VerificationStatus } from './verification-status.reader.js';

const declared: ProfileRecord = {
  givenName: 'Jean',
  familyName: 'Mukendi',
  additionalName: 'Kabongo',
  dateOfBirth: new Date('1990-05-17T00:00:00.000Z'),
  addressLine1: '3 rue déclarée',
  addressLine2: 'Appartement 2',
  city: 'Goma',
  region: 'Nord-Kivu',
  postalCode: '0001',
  timeZone: 'Africa/Lubumbashi',
  updatedAt: new Date('2026-11-01T08:00:00.000Z'),
};

const identity = {
  givenName: 'Jean-Pierre',
  familyName: 'Mukendi wa Kabongo',
  additionalName: null,
  dateOfBirth: new Date('1990-05-18T00:00:00.000Z'),
  placeOfBirth: 'Lubumbashi',
  nationality: 'CD',
};

const address = {
  addressLine1: '12 avenue Kasa-Vubu',
  addressLine2: null,
  city: 'Kinshasa',
  region: null,
  postalCode: null,
};

const NOTHING: VerificationStatus = { level: 0, identity: null, address: null };

describe('niveau de vérification d’un compte', () => {
  it('est le plus haut niveau dont tous les précédents sont vérifiés', () => {
    expect(verifiedLevelOf([])).toBe(0);
    expect(verifiedLevelOf([1])).toBe(1);
    expect(verifiedLevelOf([1, 2])).toBe(2);
    expect(verifiedLevelOf([1, 2, 3])).toBe(3);
    expect(verifiedLevelOf([3, 1, 2])).toBe(3);
  });

  it('un niveau accepté ne compte pas tant qu’un niveau précédent ne l’est pas — ou ne l’est plus', () => {
    expect(verifiedLevelOf([2])).toBe(0);
    expect(verifiedLevelOf([3])).toBe(0);
    expect(verifiedLevelOf([2, 3])).toBe(0);
    expect(verifiedLevelOf([1, 3])).toBe(1);
  });

  it('ignore ce qui n’est pas un niveau', () => {
    expect(verifiedLevelOf([0, 4, -1])).toBe(0);
    expect(verifiedLevelOf([0, 1, 4])).toBe(1);
    expect(verifiedLevelOf([1, 1, 2, 2])).toBe(2);
  });
});

describe('profil effectif', () => {
  it('sans vérification, le profil est celui que le titulaire déclare', () => {
    const { updatedAt: _ignored, ...fields } = declared;
    expect(effectiveProfileOf(declared, NOTHING)).toEqual({
      ...fields,
      placeOfBirth: null,
      nationality: null,
      identityVerified: false,
      addressVerified: false,
    });
  });

  it('sans profil ni vérification, tout est vide', () => {
    expect(effectiveProfileOf(null, NOTHING)).toEqual({
      givenName: null,
      familyName: null,
      additionalName: null,
      dateOfBirth: null,
      placeOfBirth: null,
      nationality: null,
      identityVerified: false,
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      addressVerified: false,
      timeZone: null,
    });
  });

  it('l’identité vérifiée remplace l’identité déclarée — y compris par un champ vide', () => {
    const profile = effectiveProfileOf(declared, { level: 1, identity, address: null });

    expect(profile).toMatchObject({ ...identity, identityVerified: true });
    // Le postnom déclaré ne complète pas une pièce qui n'en porte pas.
    expect(profile.additionalName).toBeNull();
    // L'adresse, elle, reste déclarée.
    expect(profile).toMatchObject({
      addressLine1: '3 rue déclarée',
      addressLine2: 'Appartement 2',
      city: 'Goma',
      region: 'Nord-Kivu',
      postalCode: '0001',
      addressVerified: false,
      timeZone: 'Africa/Lubumbashi',
    });
  });

  it('l’adresse vérifiée remplace l’adresse déclarée — y compris par un champ vide', () => {
    const profile = effectiveProfileOf(declared, { level: 2, identity, address });

    expect(profile).toMatchObject({ ...address, addressVerified: true, identityVerified: true });
    expect(profile.addressLine2).toBeNull();
    expect(profile.region).toBeNull();
    expect(profile.postalCode).toBeNull();
    // Le fuseau horaire est une préférence : il n'est jamais « vérifié ».
    expect(profile.timeZone).toBe('Africa/Lubumbashi');
  });

  it('une vérification vaut même sans aucun profil déclaré', () => {
    expect(effectiveProfileOf(null, { level: 2, identity, address })).toEqual({
      ...identity,
      identityVerified: true,
      ...address,
      addressVerified: true,
      timeZone: null,
    });
  });
});

describe('champs figés par la vérification', () => {
  const everything = {
    givenName: 'Paul',
    familyName: 'Ilunga',
    additionalName: null,
    dateOfBirth: '1991-01-01',
    addressLine1: '1 rue',
    addressLine2: null,
    city: 'Goma',
    region: null,
    postalCode: null,
    locale: 'en' as const,
    timeZone: 'Africa/Kinshasa',
  };

  it('rien n’est figé tant que rien n’est vérifié', () => {
    expect(lockedProfileFields(everything, NOTHING)).toEqual([]);
  });

  it('l’identité vérifiée fige les noms et la date de naissance, rien d’autre', () => {
    expect(lockedProfileFields(everything, { level: 1, identity, address: null })).toEqual([
      'additionalName',
      'dateOfBirth',
      'familyName',
      'givenName',
    ]);
    expect(
      lockedProfileFields(
        { city: 'Goma', locale: 'fr', timeZone: null },
        { level: 1, identity, address: null },
      ),
    ).toEqual([]);
  });

  it('l’adresse vérifiée fige l’adresse ; langue et fuseau horaire restent libres', () => {
    expect(lockedProfileFields(everything, { level: 2, identity, address })).toEqual([
      'additionalName',
      'addressLine1',
      'addressLine2',
      'city',
      'dateOfBirth',
      'familyName',
      'givenName',
      'postalCode',
      'region',
    ]);
    expect(
      lockedProfileFields(
        { locale: 'en', timeZone: 'Africa/Kinshasa' },
        { level: 2, identity, address },
      ),
    ).toEqual([]);
  });

  it('effacer un champ vérifié (`null`) est aussi une modification', () => {
    expect(lockedProfileFields({ givenName: null }, { level: 1, identity, address: null })).toEqual(
      ['givenName'],
    );
    expect(lockedProfileFields({ city: null }, { level: 2, identity, address })).toEqual(['city']);
  });

  it('les deux listes couvrent tout ce qu’un dossier accepté établit dans le profil', () => {
    expect([...IDENTITY_PROFILE_FIELDS].sort()).toEqual([
      'additionalName',
      'dateOfBirth',
      'familyName',
      'givenName',
    ]);
    expect([...ADDRESS_PROFILE_FIELDS].sort()).toEqual([
      'addressLine1',
      'addressLine2',
      'city',
      'postalCode',
      'region',
    ]);
  });
});

describe('registre des étapes de purge', () => {
  const step = (name: string) => ({ name, run: () => Promise.resolve(0) });

  it('conserve les étapes dans l’ordre où elles sont enregistrées', () => {
    const registry = new MaintenanceStepRegistry();
    expect(registry.steps()).toEqual([]);
    const first = step('purge-a');
    const second = step('purge-b');
    registry.register(first);
    registry.register(second);
    expect(registry.steps()).toEqual([first, second]);
  });

  it('refuse deux étapes du même nom : le compte rendu ne saurait pas les distinguer', () => {
    const registry = new MaintenanceStepRegistry();
    registry.register(step('purge-a'));
    expect(() => {
      registry.register(step('purge-a'));
    }).toThrow('Maintenance step "purge-a" is already registered.');
    expect(registry.steps()).toHaveLength(1);
  });
});
