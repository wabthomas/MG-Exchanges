import { describe, expect, it } from '@jest/globals';

import { isAcceptanceRequired, localesOf, TERMS_VERSION_LIST_MAX, textIn } from './terms-policy.js';

describe('conditions d’utilisation — règle d’acceptation', () => {
  it('rien n’est exigé tant qu’aucune version ne l’exige', () => {
    expect(isAcceptanceRequired(null, null)).toBe(false);
    // Des versions « pour information » ont pu être acceptées : cela ne crée aucune obligation.
    expect(isAcceptanceRequired(null, 3)).toBe(false);
  });

  it('un compte qui n’a rien accepté doit accepter dès qu’une version l’exige', () => {
    expect(isAcceptanceRequired(1, null)).toBe(true);
    expect(isAcceptanceRequired(7, null)).toBe(true);
  });

  it.each([
    // [dernière version qui l'exige, dernière version acceptée, attendu]
    [1, 1, false],
    [3, 3, false],
    // Une version antérieure à celle qui l'exige ne suffit pas.
    [3, 2, true],
    [3, 1, true],
    [10, 9, true],
    // Accepter une version publiée depuis tient lieu des précédentes : c'est le texte en vigueur.
    [3, 4, false],
    [3, 40, false],
    [1, 2, false],
  ])('dernière exigée %i, dernière acceptée %i → %s', (latestRequired, lastAccepted, expected) => {
    expect(isAcceptanceRequired(latestRequired, lastAccepted)).toBe(expected);
  });

  it('la frontière est stricte : la version exigée elle-même suffit, la précédente non', () => {
    for (let required = 1; required <= 20; required += 1) {
      expect(isAcceptanceRequired(required, required)).toBe(false);
      expect(isAcceptanceRequired(required, required + 1)).toBe(false);
      if (required > 1) {
        expect(isAcceptanceRequired(required, required - 1)).toBe(true);
      }
    }
  });
});

describe('conditions d’utilisation — langue servie', () => {
  const fr = { summary: 'Résumé.' };
  const en = { summary: 'Summary.' };

  it('la langue demandée si la version a été publiée dans cette langue', () => {
    expect(textIn({ fr, en }, 'en')).toEqual({ locale: 'en', text: en });
    expect(textIn({ fr, en }, 'fr')).toEqual({ locale: 'fr', text: fr });
  });

  it('le français sinon — c’est lui qui fait foi —, et la réponse le dit', () => {
    expect(textIn({ fr, en: null }, 'en')).toEqual({ locale: 'fr', text: fr });
    expect(textIn({ fr, en: null }, 'fr')).toEqual({ locale: 'fr', text: fr });
  });

  it('les langues d’une version : le français toujours, l’anglais s’il a été publié', () => {
    expect(localesOf({ en: null })).toEqual(['fr']);
    expect(localesOf({ en })).toEqual(['fr', 'en']);
  });

  it('une liste rend au plus cent versions', () => {
    expect(TERMS_VERSION_LIST_MAX).toBe(100);
  });
});
