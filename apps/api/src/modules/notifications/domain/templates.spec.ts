import { describe, expect, it } from '@jest/globals';
import { SUPPORTED_LOCALES } from '@mgx/validation';

import type { NotificationContent } from './notification.js';
import { renderNotification } from './templates.js';

const CONTENTS: readonly NotificationContent[] = [
  { template: 'email_verification_code', code: '042137', ttlMinutes: 15 },
  { template: 'password_reset_code', code: '042137', ttlMinutes: 15 },
  { template: 'account_already_exists' },
  { template: 'password_changed' },
];

describe('rédaction des messages', () => {
  const cases = SUPPORTED_LOCALES.flatMap((locale) =>
    CONTENTS.map((content) => ({ locale, content, name: `${content.template} (${locale})` })),
  );

  it.each(cases)('$name : objet et texte rédigés, sans variable oubliée', ({ locale, content }) => {
    const rendered = renderNotification({
      channel: 'EMAIL',
      recipient: 'jean@example.cd',
      locale,
      content,
    });

    expect(rendered).toMatchObject({
      channel: 'EMAIL',
      recipient: 'jean@example.cd',
      template: content.template,
      locale,
    });
    expect(rendered.subject).toContain('MG-Exchange');
    expect(rendered.subject.length).toBeLessThan(80);
    expect(rendered.text.length).toBeGreaterThan(60);
    expect(`${rendered.subject}${rendered.text}`).not.toMatch(/undefined|\$\{|\[object/);
  });

  it.each(SUPPORTED_LOCALES)(
    '%s : un message de code porte le code, sa durée et la mise en garde',
    (locale) => {
      for (const template of ['email_verification_code', 'password_reset_code'] as const) {
        const { text, subject } = renderNotification({
          channel: 'EMAIL',
          recipient: 'jean@example.cd',
          locale,
          content: { template, code: '042137', ttlMinutes: 15 },
        });
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

  it('les messages d’information ne contiennent aucun code', () => {
    for (const template of ['account_already_exists', 'password_changed'] as const) {
      const { text } = renderNotification({
        channel: 'EMAIL',
        recipient: 'jean@example.cd',
        locale: 'fr',
        content: { template },
      });
      expect(text).not.toMatch(/\d{6}/);
    }
  });

  it('les deux langues diffèrent réellement', () => {
    for (const content of CONTENTS) {
      const [fr, en] = SUPPORTED_LOCALES.map(
        (locale) =>
          renderNotification({ channel: 'EMAIL', recipient: 'jean@example.cd', locale, content })
            .text,
      );
      expect(fr).not.toBe(en);
    }
  });
});
