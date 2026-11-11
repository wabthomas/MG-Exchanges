import type { SupportedLocale } from '@mgx/validation';

import type {
  NotificationContent,
  NotificationMessage,
  RenderedNotification,
} from './notification.js';

const PRODUCT = 'MG-Exchange';

interface Rendered {
  readonly subject: string;
  readonly text: string;
}

const NEVER_SHARE: Readonly<Record<SupportedLocale, string>> = {
  fr: `Ne communiquez jamais ce code : ${PRODUCT} ne vous le demandera ni par téléphone, ni par message.`,
  en: `Never share this code: ${PRODUCT} will never ask for it by phone or by message.`,
};

const NOT_YOU: Readonly<Record<SupportedLocale, string>> = {
  fr: "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : aucune action n'est requise.",
  en: 'If you did not make this request, ignore this message: no action is needed.',
};

function render(content: NotificationContent, locale: SupportedLocale): Rendered {
  switch (content.template) {
    case 'email_verification_code':
      return locale === 'fr'
        ? {
            subject: `${PRODUCT} — votre code de vérification`,
            text: [
              `Votre code de vérification ${PRODUCT} : ${content.code}`,
              `Il est valable ${content.ttlMinutes} minutes.`,
              NEVER_SHARE.fr,
              NOT_YOU.fr,
            ].join('\n\n'),
          }
        : {
            subject: `${PRODUCT} — your verification code`,
            text: [
              `Your ${PRODUCT} verification code: ${content.code}`,
              `It is valid for ${content.ttlMinutes} minutes.`,
              NEVER_SHARE.en,
              NOT_YOU.en,
            ].join('\n\n'),
          };

    case 'password_reset_code':
      return locale === 'fr'
        ? {
            subject: `${PRODUCT} — réinitialisation de votre mot de passe`,
            text: [
              `Votre code de réinitialisation ${PRODUCT} : ${content.code}`,
              `Il est valable ${content.ttlMinutes} minutes.`,
              NEVER_SHARE.fr,
              NOT_YOU.fr,
            ].join('\n\n'),
          }
        : {
            subject: `${PRODUCT} — password reset`,
            text: [
              `Your ${PRODUCT} password reset code: ${content.code}`,
              `It is valid for ${content.ttlMinutes} minutes.`,
              NEVER_SHARE.en,
              NOT_YOU.en,
            ].join('\n\n'),
          };

    case 'account_already_exists':
      return locale === 'fr'
        ? {
            subject: `${PRODUCT} — vous avez déjà un compte`,
            text: [
              `Une inscription vient d'être demandée avec cette adresse, déjà associée à un compte ${PRODUCT}.`,
              'Aucun nouveau compte n’a été créé. Si vous avez oublié votre mot de passe, utilisez « Mot de passe oublié » sur l’écran de connexion.',
              NOT_YOU.fr,
            ].join('\n\n'),
          }
        : {
            subject: `${PRODUCT} — you already have an account`,
            text: [
              `A sign-up was just requested with this address, which already belongs to a ${PRODUCT} account.`,
              'No new account was created. If you forgot your password, use "Forgot password" on the sign-in screen.',
              NOT_YOU.en,
            ].join('\n\n'),
          };

    case 'password_changed':
      return locale === 'fr'
        ? {
            subject: `${PRODUCT} — votre mot de passe a été modifié`,
            text: [
              `Le mot de passe de votre compte ${PRODUCT} vient d'être modifié. Vos autres sessions ont été fermées.`,
              "Si vous n'êtes pas à l'origine de ce changement, réinitialisez immédiatement votre mot de passe et contactez le support.",
            ].join('\n\n'),
          }
        : {
            subject: `${PRODUCT} — your password was changed`,
            text: [
              `The password of your ${PRODUCT} account was just changed. Your other sessions were signed out.`,
              'If you did not make this change, reset your password immediately and contact support.',
            ].join('\n\n'),
          };
  }
}

/** Rédige un message dans la langue du destinataire. */
export function renderNotification(message: NotificationMessage): RenderedNotification {
  return {
    channel: message.channel,
    recipient: message.recipient,
    template: message.content.template,
    locale: message.locale,
    ...render(message.content, message.locale),
  };
}
