import type { KycLevel, KycRejectionReason } from '@mgx/contracts';
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
  | { readonly template: 'account_reactivated' }
  | { readonly template: 'identity_verification_approved'; readonly level: KycLevel }
  | {
      readonly template: 'identity_verification_rejected';
      readonly level: KycLevel;
      /** Motifs du refus, dans l'ordre où la conformité les a donnés. */
      readonly reasons: readonly KycRejectionReason[];
    }
  | { readonly template: 'identity_verification_revoked'; readonly level: KycLevel }
  | {
      readonly template: 'account_closed';
      /** Vrai si la clôture a été prononcée par la plateforme, et non demandée depuis le compte. */
      readonly byStaff: boolean;
      /** Date à partir de laquelle ce qui reste du compte est effacé (ISO 8601, UTC). */
      readonly erasureDueAt: string;
      /** Terme de la conservation légale des dossiers de vérification, s'il y en a une. */
      readonly retainedUntil: string | null;
    }
  | {
      readonly template: 'data_exported';
      /** Date de la remise de la copie (ISO 8601, UTC). */
      readonly occurredAt: string;
      readonly ipAddress: string | null;
    }
  | ({ readonly template: 'transfer_sent' } & TransferNoticeDetails)
  | ({ readonly template: 'transfer_received' } & TransferNoticeDetails);

/** Ce que dit d'un transfert le message adressé à l'une de ses deux parties. */
export interface TransferNoticeDetails {
  /** Montant, en chaîne décimale au nombre de décimales de l'actif. */
  readonly amount: string;
  readonly assetCode: string;
  /** Adresse de l'autre partie ; `null` si son compte a été clôturé depuis. */
  readonly counterparty: string | null;
  /** Date du transfert (ISO 8601, UTC). */
  readonly occurredAt: string;
}

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
