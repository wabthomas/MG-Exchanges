/**
 * Description sommaire d'un appareil, déduite de l'agent utilisateur : « Chrome — Windows »,
 * « Android »… Elle ne contient que des noms de produits, identiques dans toutes les langues.
 *
 * Elle figure dans les messages de sécurité adressés au titulaire d'un compte. Ni l'agent
 * utilisateur brut ni le nom d'appareil choisi par le client n'y sont recopiés : ce sont des
 * textes libres, fournis par la personne qui se connecte — donc, précisément dans le cas que
 * le message signale, par un tiers qui pourrait y glisser une consigne ou un lien trompeurs.
 */

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/iPhone|iPad|iPod|CFNetwork|Darwin\//, 'iOS'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'macOS'],
  [/Linux|X11/, 'Linux'],
];

// L'ordre compte : Edge et Opera se présentent aussi comme Chrome, et Chrome comme Safari.
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

export function describeUserAgent(userAgent: string | undefined): string | null {
  if (userAgent === undefined || userAgent === '') {
    return null;
  }
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  if (browser === null) {
    return system;
  }
  return system === null ? browser : `${browser} — ${system}`;
}
