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

type Localized = Readonly<Record<SupportedLocale, string>>;

const NEVER_SHARE: Localized = {
  fr: `Ne communiquez jamais ce code : ${PRODUCT} ne vous le demandera ni par téléphone, ni par message.`,
  en: `Never share this code: ${PRODUCT} will never ask for it by phone or by message.`,
};

const NOT_YOU: Localized = {
  fr: "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : aucune action n'est requise.",
  en: 'If you did not make this request, ignore this message: no action is needed.',
};

const NOT_YOUR_CHANGE: Localized = {
  fr: "Si vous n'êtes pas à l'origine de ce changement, changez immédiatement votre mot de passe et contactez le support.",
  en: 'If you did not make this change, change your password immediately and contact support.',
};

const paragraphs = (...parts: readonly string[]): string => parts.join('\n\n');

/** `2026-11-11T20:15:42.123Z` → `2026-11-11 20:15 UTC`. */
function formatUtc(isoDateTime: string): string {
  return `${isoDateTime.slice(0, 10)} ${isoDateTime.slice(11, 16)} UTC`;
}

/** `15` → « 15 minutes » ; `1440` → « 24 heures » / "24 hours". */
function formatDuration(minutes: number, locale: SupportedLocale): string {
  if (minutes >= 120 && minutes % 60 === 0) {
    return `${minutes / 60} ${locale === 'fr' ? 'heures' : 'hours'}`;
  }
  return `${minutes} minutes`;
}

function render(content: NotificationContent, locale: SupportedLocale): Rendered {
  const fr = locale === 'fr';

  switch (content.template) {
    case 'email_verification_code':
      return fr
        ? {
            subject: `${PRODUCT} — votre code de vérification`,
            text: paragraphs(
              `Votre code de vérification ${PRODUCT} : ${content.code}`,
              `Il est valable ${content.ttlMinutes} minutes.`,
              NEVER_SHARE.fr,
              NOT_YOU.fr,
            ),
          }
        : {
            subject: `${PRODUCT} — your verification code`,
            text: paragraphs(
              `Your ${PRODUCT} verification code: ${content.code}`,
              `It is valid for ${content.ttlMinutes} minutes.`,
              NEVER_SHARE.en,
              NOT_YOU.en,
            ),
          };

    case 'password_reset_code':
      return fr
        ? {
            subject: `${PRODUCT} — réinitialisation de votre mot de passe`,
            text: paragraphs(
              `Votre code de réinitialisation ${PRODUCT} : ${content.code}`,
              `Il est valable ${content.ttlMinutes} minutes.`,
              NEVER_SHARE.fr,
              NOT_YOU.fr,
            ),
          }
        : {
            subject: `${PRODUCT} — password reset`,
            text: paragraphs(
              `Your ${PRODUCT} password reset code: ${content.code}`,
              `It is valid for ${content.ttlMinutes} minutes.`,
              NEVER_SHARE.en,
              NOT_YOU.en,
            ),
          };

    // SMS : un seul segment (160 caractères de l'alphabet GSM 7 bits), sans lien ni objet.
    case 'phone_verification_code':
      return fr
        ? {
            subject: PRODUCT,
            text: `${PRODUCT} : votre code de vérification est ${content.code}. Valable ${content.ttlMinutes} minutes. Ne le communiquez à personne.`,
          }
        : {
            subject: PRODUCT,
            text: `${PRODUCT}: your verification code is ${content.code}. Valid for ${content.ttlMinutes} minutes. Never share it with anyone.`,
          };

    case 'account_already_exists':
      return fr
        ? {
            subject: `${PRODUCT} — vous avez déjà un compte`,
            text: paragraphs(
              `Une inscription vient d'être demandée avec cette adresse, déjà associée à un compte ${PRODUCT}.`,
              'Aucun nouveau compte n’a été créé. Si vous avez oublié votre mot de passe, utilisez « Mot de passe oublié » sur l’écran de connexion.',
              NOT_YOU.fr,
            ),
          }
        : {
            subject: `${PRODUCT} — you already have an account`,
            text: paragraphs(
              `A sign-up was just requested with this address, which already belongs to a ${PRODUCT} account.`,
              'No new account was created. If you forgot your password, use "Forgot password" on the sign-in screen.',
              NOT_YOU.en,
            ),
          };

    case 'registration_incomplete':
      return fr
        ? {
            subject: `${PRODUCT} — inscription à terminer`,
            text: paragraphs(
              `Une réinitialisation de mot de passe vient d'être demandée pour cette adresse, mais l'inscription correspondante n'a jamais été terminée : il n'y a pas encore de compte ${PRODUCT} à cette adresse.`,
              "Pour créer votre compte, recommencez simplement l'inscription avec cette adresse.",
              NOT_YOU.fr,
            ),
          }
        : {
            subject: `${PRODUCT} — finish signing up`,
            text: paragraphs(
              `A password reset was just requested for this address, but the corresponding sign-up was never completed: there is no ${PRODUCT} account at this address yet.`,
              'To create your account, simply sign up again with this address.',
              NOT_YOU.en,
            ),
          };

    case 'password_changed':
      return fr
        ? {
            subject: `${PRODUCT} — votre mot de passe a été modifié`,
            text: paragraphs(
              `Le mot de passe de votre compte ${PRODUCT} vient d'être modifié. Vos autres sessions ont été fermées.`,
              "Si vous n'êtes pas à l'origine de ce changement, réinitialisez immédiatement votre mot de passe et contactez le support.",
            ),
          }
        : {
            subject: `${PRODUCT} — your password was changed`,
            text: paragraphs(
              `The password of your ${PRODUCT} account was just changed. Your other sessions were signed out.`,
              'If you did not make this change, reset your password immediately and contact support.',
            ),
          };

    case 'new_sign_in':
      return fr
        ? {
            subject: `${PRODUCT} — nouvelle connexion à votre compte`,
            text: paragraphs(
              `Une connexion à votre compte ${PRODUCT} vient d'avoir lieu depuis un appareil que nous ne reconnaissons pas.`,
              [
                `Date : ${formatUtc(content.occurredAt)}`,
                `Appareil : ${content.device ?? 'inconnu'}`,
                `Adresse IP : ${content.ipAddress ?? 'inconnue'}`,
              ].join('\n'),
              "Si c'était vous, aucune action n'est requise. Sinon, changez immédiatement votre mot de passe, fermez vos autres sessions et contactez le support.",
            ),
          }
        : {
            subject: `${PRODUCT} — new sign-in to your account`,
            text: paragraphs(
              `Your ${PRODUCT} account was just signed in to from a device we do not recognise.`,
              [
                `Date: ${formatUtc(content.occurredAt)}`,
                `Device: ${content.device ?? 'unknown'}`,
                `IP address: ${content.ipAddress ?? 'unknown'}`,
              ].join('\n'),
              'If this was you, no action is needed. Otherwise, change your password immediately, sign out your other sessions and contact support.',
            ),
          };

    case 'two_factor_enabled':
      return fr
        ? {
            subject: `${PRODUCT} — validation en deux étapes activée`,
            text: paragraphs(
              `La validation en deux étapes vient d'être activée sur votre compte ${PRODUCT} : un code de votre application d'authentification vous sera demandé à chaque connexion. Vos autres sessions ont été fermées.`,
              'Conservez vos codes de secours en lieu sûr : ils vous permettront de vous connecter si vous perdez votre téléphone.',
              NOT_YOUR_CHANGE.fr,
            ),
          }
        : {
            subject: `${PRODUCT} — two-step verification enabled`,
            text: paragraphs(
              `Two-step verification was just enabled on your ${PRODUCT} account: a code from your authenticator app will be required at every sign-in. Your other sessions were signed out.`,
              'Keep your recovery codes in a safe place: they let you sign in if you lose your phone.',
              NOT_YOUR_CHANGE.en,
            ),
          };

    case 'two_factor_disabled':
      if (content.bySupport) {
        return fr
          ? {
              subject: `${PRODUCT} — validation en deux étapes retirée`,
              text: paragraphs(
                `À la suite d'une demande adressée au support, la validation en deux étapes a été retirée de votre compte ${PRODUCT} et toutes vos sessions ont été fermées.`,
                'Nous vous recommandons de la réactiver dès votre prochaine connexion.',
                "Si vous n'avez rien demandé, contactez immédiatement le support.",
              ),
            }
          : {
              subject: `${PRODUCT} — two-step verification removed`,
              text: paragraphs(
                `Following a request made to support, two-step verification was removed from your ${PRODUCT} account and all your sessions were signed out.`,
                'We recommend enabling it again at your next sign-in.',
                'If you did not ask for this, contact support immediately.',
              ),
            };
      }
      return fr
        ? {
            subject: `${PRODUCT} — validation en deux étapes désactivée`,
            text: paragraphs(
              `La validation en deux étapes vient d'être désactivée sur votre compte ${PRODUCT} : votre mot de passe suffit désormais pour vous connecter. Vos autres sessions ont été fermées.`,
              NOT_YOUR_CHANGE.fr,
            ),
          }
        : {
            subject: `${PRODUCT} — two-step verification disabled`,
            text: paragraphs(
              `Two-step verification was just disabled on your ${PRODUCT} account: your password alone is now enough to sign in. Your other sessions were signed out.`,
              NOT_YOUR_CHANGE.en,
            ),
          };

    case 'recovery_code_used':
      return fr
        ? {
            subject: `${PRODUCT} — un code de secours a été utilisé`,
            text: paragraphs(
              `Un code de secours vient d'être utilisé à la place de votre application d'authentification sur votre compte ${PRODUCT}.`,
              `Codes de secours restants : ${content.remaining}. Vous pouvez en générer de nouveaux depuis les réglages de sécurité.`,
              NOT_YOUR_CHANGE.fr,
            ),
          }
        : {
            subject: `${PRODUCT} — a recovery code was used`,
            text: paragraphs(
              `A recovery code was just used instead of your authenticator app on your ${PRODUCT} account.`,
              `Recovery codes left: ${content.remaining}. You can generate new ones from the security settings.`,
              NOT_YOUR_CHANGE.en,
            ),
          };

    case 'second_factor_blocked': {
      const duration = formatDuration(content.blockedMinutes, locale);
      return fr
        ? {
            subject: `${PRODUCT} — codes de validation erronés sur votre compte`,
            text: paragraphs(
              `Plusieurs codes de validation en deux étapes erronés viennent d'être saisis sur votre compte ${PRODUCT}, après votre mot de passe. Par précaution, la seconde étape de la connexion est bloquée pendant ${duration}.`,
              "Si c'était vous, patientez puis réessayez en vérifiant que l'heure de votre téléphone est réglée automatiquement.",
              "Si ce n'était pas vous, quelqu'un connaît votre mot de passe : changez-le dès maintenant avec « Mot de passe oublié » sur l'écran de connexion. Votre compte reste protégé par la validation en deux étapes.",
            ),
          }
        : {
            subject: `${PRODUCT} — incorrect verification codes on your account`,
            text: paragraphs(
              `Several incorrect two-step verification codes were just entered on your ${PRODUCT} account, after your password. As a precaution, the second step of the sign-in is blocked for ${duration}.`,
              'If this was you, wait and try again, checking that the time of your phone is set automatically.',
              'If this was not you, someone knows your password: change it now with "Forgot password" on the sign-in screen. Your account remains protected by two-step verification.',
            ),
          };
    }

    case 'account_suspended':
      return fr
        ? {
            subject: `${PRODUCT} — votre compte a été suspendu`,
            text: paragraphs(
              `Votre compte ${PRODUCT} a été suspendu : vous ne pouvez plus vous connecter et vos sessions ont été fermées.`,
              'Pour en connaître la raison ou contester cette décision, contactez le support.',
            ),
          }
        : {
            subject: `${PRODUCT} — your account was suspended`,
            text: paragraphs(
              `Your ${PRODUCT} account was suspended: you can no longer sign in and your sessions were signed out.`,
              'To learn why or to contest this decision, contact support.',
            ),
          };

    case 'account_reactivated':
      return fr
        ? {
            subject: `${PRODUCT} — votre compte a été réactivé`,
            text: `Votre compte ${PRODUCT} a été réactivé : vous pouvez de nouveau vous connecter avec votre mot de passe habituel.`,
          }
        : {
            subject: `${PRODUCT} — your account was reactivated`,
            text: `Your ${PRODUCT} account was reactivated: you can sign in again with your usual password.`,
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
