import type { SupportedLocale } from '@mgx/validation';

/** Contenu d'un message : un modèle et les valeurs qu'il attend. */
export type NotificationContent =
  | {
      readonly template: 'email_verification_code';
      readonly code: string;
      readonly ttlMinutes: number;
    }
  | { readonly template: 'password_reset_code'; readonly code: string; readonly ttlMinutes: number }
  | {
      readonly template: 'phone_verification_code';
      readonly code: string;
      readonly ttlMinutes: number;
    }
  | { readonly template: 'account_already_exists' }
  | { readonly template: 'registration_incomplete' }
  | { readonly template: 'password_changed' }
  | {
      readonly template: 'new_sign_in';
      /** Date de la connexion (ISO 8601, UTC). */
      readonly occurredAt: string;
      readonly ipAddress: string | null;
      /** Nom de l'appareil ou, à défaut, agent utilisateur. */
      readonly device: string | null;
    }
  | { readonly template: 'two_factor_enabled' }
  | {
      readonly template: 'two_factor_disabled';
      /** Vrai si la désactivation a été effectuée par le support, à la demande du titulaire. */
      readonly bySupport: boolean;
    }
  | { readonly template: 'recovery_code_used'; readonly remaining: number }
  | {
      readonly template: 'second_factor_blocked';
      /** Durée du blocage de la seconde étape, en minutes. */
      readonly blockedMinutes: number;
    }
  | { readonly template: 'account_suspended' }
  | { readonly template: 'account_reactivated' };

export type NotificationTemplate = NotificationContent['template'];

/** Canaux de remise : e-mail, et SMS pour la vérification du numéro de téléphone. */
export type NotificationChannel = 'EMAIL' | 'SMS';

export interface NotificationMessage {
  readonly channel: NotificationChannel;
  /** Adresse du destinataire sur le canal choisi : adresse e-mail, ou numéro au format E.164. */
  readonly recipient: string;
  readonly locale: SupportedLocale;
  readonly content: NotificationContent;
}

/** Message prêt à être remis : objet et texte rédigés dans la langue du destinataire. */
export interface RenderedNotification {
  readonly channel: NotificationChannel;
  readonly recipient: string;
  readonly template: NotificationTemplate;
  readonly locale: SupportedLocale;
  /** Objet de l'e-mail. Un SMS n'en a pas : pour ce canal, c'est une simple étiquette. */
  readonly subject: string;
  readonly text: string;
}
