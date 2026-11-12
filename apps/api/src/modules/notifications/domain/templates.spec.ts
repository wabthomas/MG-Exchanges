import { describe, expect, it } from '@jest/globals';
import { SUPPORTED_LOCALES } from '@mgx/validation';

import type { NotificationContent, NotificationTemplate } from './notification.js';
import { renderNotification } from './templates.js';

/**
 * Un contenu d'exemple par modèle. Le type impose l'exhaustivité : ajouter un modèle sans
 * l'ajouter ici ne compile pas, et il est alors soumis à tous les contrôles ci-dessous.
 */
const SAMPLES: {
  readonly [T in NotificationTemplate]: readonly Extract<NotificationContent, { template: T }>[];
} = {
  email_verification_code: [
    { template: 'email_verification_code', code: '042137', ttlMinutes: 15 },
  ],
  password_reset_code: [{ template: 'password_reset_code', code: '042137', ttlMinutes: 15 }],
  phone_verification_code: [
    { template: 'phone_verification_code', code: '042137', ttlMinutes: 15 },
  ],
  account_already_exists: [{ template: 'account_already_exists' }],
  registration_incomplete: [{ template: 'registration_incomplete' }],
  password_changed: [{ template: 'password_changed' }],
  new_sign_in: [
    {
      template: 'new_sign_in',
      occurredAt: '2026-11-11T20:15:42.123Z',
      ipAddress: '203.0.113.7',
      device: 'iPhone de Jean',
    },
    {
      template: 'new_sign_in',
      occurredAt: '2026-11-11T20:15:42.123Z',
      ipAddress: null,
      device: null,
    },
  ],
  two_factor_enabled: [{ template: 'two_factor_enabled' }],
  two_factor_disabled: [
    { template: 'two_factor_disabled', bySupport: false },
    { template: 'two_factor_disabled', bySupport: true },
  ],
  recovery_code_used: [{ template: 'recovery_code_used', remaining: 7 }],
  second_factor_blocked: [
    { template: 'second_factor_blocked', blockedMinutes: 15 },
    { template: 'second_factor_blocked', blockedMinutes: 1440 },
  ],
  account_suspended: [{ template: 'account_suspended' }],
  account_reactivated: [{ template: 'account_reactivated' }],
};

const CONTENTS: readonly NotificationContent[] = Object.values(SAMPLES).flat();
const SMS_TEMPLATES: readonly NotificationTemplate[] = ['phone_verification_code'];
const CODE_TEMPLATES: readonly NotificationTemplate[] = [
  'email_verification_code',
  'password_reset_code',
  'phone_verification_code',
];

const channelOf = (template: NotificationTemplate) =>
  SMS_TEMPLATES.includes(template) ? ('SMS' as const) : ('EMAIL' as const);
const recipientOf = (template: NotificationTemplate) =>
  channelOf(template) === 'SMS' ? '+243812345678' : 'jean@example.cd';

function rendered(content: NotificationContent, locale: (typeof SUPPORTED_LOCALES)[number]) {
  return renderNotification({
    channel: channelOf(content.template),
    recipient: recipientOf(content.template),
    locale,
    content,
  });
}

/** Alphabet GSM 7 bits de base (3GPP TS 23.038) : hors de lui, un SMS passe en UCS-2 (70 caractères). */
const GSM_7_BIT =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

describe('rédaction des messages', () => {
  const cases = SUPPORTED_LOCALES.flatMap((locale) =>
    CONTENTS.map((content, index) => ({
      locale,
      content,
      name: `${content.template} #${String(index)} (${locale})`,
    })),
  );

  it.each(cases)('$name : objet et texte rédigés, sans variable oubliée', ({ locale, content }) => {
    const message = rendered(content, locale);

    expect(message).toMatchObject({
      channel: channelOf(content.template),
      recipient: recipientOf(content.template),
      template: content.template,
      locale,
    });
    expect(message.subject).toContain('MG-Exchange');
    expect(message.subject.length).toBeLessThan(80);
    expect(message.text.length).toBeGreaterThan(60);
    expect(`${message.subject}${message.text}`).not.toMatch(/undefined|null|NaN|\$\{|\[object/);
  });

  it('les deux langues diffèrent réellement, pour chaque message', () => {
    for (const content of CONTENTS) {
      const [fr, en] = SUPPORTED_LOCALES.map((locale) => rendered(content, locale));
      expect(fr?.text).not.toBe(en?.text);
      if (channelOf(content.template) === 'EMAIL') {
        expect(fr?.subject).not.toBe(en?.subject);
      }
    }
  });

  it.each(SUPPORTED_LOCALES)(
    '%s : un e-mail de code porte le code, sa durée et la mise en garde',
    (locale) => {
      for (const template of ['email_verification_code', 'password_reset_code'] as const) {
        const { text, subject } = rendered({ template, code: '042137', ttlMinutes: 15 }, locale);
        expect(text).toContain('042137');
        expect(text).toContain('15 minutes');
        expect(text).toMatch(
          locale === 'fr' ? /Ne communiquez jamais ce code/ : /Never share this code/,
        );
        // Le code ne figure pas dans l'objet : il s'afficherait dans les notifications de l'appareil.
        expect(subject).not.toContain('042137');
      }
    },
  );

  it.each(SUPPORTED_LOCALES)(
    '%s : le SMS de code tient en un seul segment GSM 7 bits, sans lien',
    (locale) => {
      const { text } = rendered(
        { template: 'phone_verification_code', code: '042137', ttlMinutes: 15 },
        locale,
      );
      expect(text).toContain('042137');
      expect(text).toContain('15 minutes');
      expect(text.length).toBeLessThanOrEqual(160);
      expect(Array.from(text).filter((character) => !GSM_7_BIT.includes(character))).toEqual([]);
      expect(text).not.toMatch(/https?:|www\./);
      expect(text).toMatch(locale === 'fr' ? /Ne le communiquez à personne/ : /Never share it/);
    },
  );

  it('seuls les messages de code contiennent un code', () => {
    for (const content of CONTENTS) {
      for (const locale of SUPPORTED_LOCALES) {
        const { text } = rendered(content, locale);
        if (CODE_TEMPLATES.includes(content.template)) {
          expect(text).toMatch(/\b\d{6}\b/);
        } else {
          expect(text).not.toMatch(/\b\d{6}\b/);
        }
      }
    }
  });

  it('aucun message ne contient de lien : on ne clique pas dans un e-mail de sécurité', () => {
    for (const content of CONTENTS) {
      for (const locale of SUPPORTED_LOCALES) {
        const message = rendered(content, locale);
        expect(`${message.subject}\n${message.text}`).not.toMatch(/https?:\/\/|www\./i);
      }
    }
  });

  it('la connexion depuis un nouvel appareil dit quand, d’où et avec quoi', () => {
    const [known, unknown] = SAMPLES.new_sign_in;
    if (known === undefined || unknown === undefined) {
      throw new Error('Missing samples.');
    }
    const fr = rendered(known, 'fr').text;
    expect(fr).toContain('Date : 2026-11-11 20:15 UTC');
    expect(fr).toContain('Appareil : iPhone de Jean');
    expect(fr).toContain('Adresse IP : 203.0.113.7');
    expect(fr).toMatch(/changez immédiatement votre mot de passe/);

    const en = rendered(unknown, 'en').text;
    expect(en).toContain('Device: unknown');
    expect(en).toContain('IP address: unknown');
  });

  it('le retrait du second facteur par le support se distingue de la désactivation par le titulaire', () => {
    const [own, support] = SAMPLES.two_factor_disabled.map((content) => rendered(content, 'fr'));
    expect(own?.subject).toContain('désactivée');
    expect(own?.text).toMatch(/Si vous n'êtes pas à l'origine de ce changement/);
    expect(support?.subject).toContain('retirée');
    expect(support?.text).toMatch(/demande adressée au support/);
    expect(support?.text).toMatch(/toutes vos sessions ont été fermées/);
  });

  it('un code de secours utilisé annonce combien il en reste', () => {
    expect(rendered({ template: 'recovery_code_used', remaining: 7 }, 'fr').text).toContain(
      'Codes de secours restants : 7.',
    );
    expect(rendered({ template: 'recovery_code_used', remaining: 0 }, 'en').text).toContain(
      'Recovery codes left: 0.',
    );
  });

  it('le blocage de la seconde étape annonce sa durée en minutes ou en heures', () => {
    const text = (blockedMinutes: number, locale: 'fr' | 'en') =>
      rendered({ template: 'second_factor_blocked', blockedMinutes }, locale).text;
    expect(text(15, 'fr')).toContain('bloquée pendant 15 minutes');
    expect(text(1440, 'fr')).toContain('bloquée pendant 24 heures');
    expect(text(1440, 'en')).toContain('blocked for 24 hours');
    expect(text(90, 'en')).toContain('blocked for 90 minutes');
    // Le message dit quoi faire si le titulaire n'y est pour rien : quelqu'un connaît son mot de passe.
    expect(text(15, 'fr')).toMatch(/quelqu'un connaît votre mot de passe/);
  });

  it('la suspension ne donne jamais sa raison ; elle indique comment la contester', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const { text } = rendered({ template: 'account_suspended' }, locale);
      expect(text).toMatch(locale === 'fr' ? /contactez le support/ : /contact support/);
      expect(text.split('\n\n')).toHaveLength(2);
    }
  });
});
