import type { FeatureKey } from '@mgx/contracts';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AppError } from '../../../common/errors/app-error.js';
import { UnitOfWork } from '../../../infrastructure/database/unit-of-work.js';
import { AuditService } from '../../audit/application/audit.service.js';
import type { AuditActor } from '../../audit/domain/audit-entry.js';
import { OutboxService } from '../../outbox/application/outbox.service.js';
import {
  FEATURE_SETTING_KEYS,
  resolveSnapshot,
  type SettingKey,
  settingSchema,
  type SettingsSnapshot,
  type SettingValue,
} from '../domain/setting-definitions.js';
import { SystemSettingsRepository } from './system-settings.repository.js';

export const SYSTEM_SETTING_CHANGED_EVENT = 'system_setting.changed';

/** Durée de validité de l'état mis en mémoire par chaque instance. */
const SNAPSHOT_TTL_MS = 5000;

export interface SettingChangeContext {
  readonly actor: AuditActor;
  readonly requestId?: string;
  /** Justification de la modification, conservée dans le journal d'audit. */
  readonly reason?: string;
}

/**
 * Paramètres de la plateforme : mode maintenance et activation des fonctionnalités.
 *
 * Lecture : l'état est consulté à chaque requête, il est donc mémorisé quelques secondes
 * par instance (une modification est visible partout en moins de {@link SNAPSHOT_TTL_MS} ms).
 *
 * Écriture : la nouvelle valeur, son entrée d'audit et l'événement `system_setting.changed`
 * sont enregistrés dans une même transaction.
 */
@Injectable()
export class SystemSettingsService {
  private cached: { readonly snapshot: SettingsSnapshot; readonly expiresAt: number } | null = null;
  private loading: Promise<SettingsSnapshot> | null = null;

  constructor(
    private readonly repository: SystemSettingsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SystemSettingsService.name);
  }

  async getSnapshot(): Promise<SettingsSnapshot> {
    if (this.cached !== null && this.cached.expiresAt > Date.now()) {
      return this.cached.snapshot;
    }
    // Une seule lecture en base à la fois, partagée par les requêtes concurrentes.
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async isFeatureEnabled(feature: FeatureKey): Promise<boolean> {
    const { features } = await this.getSnapshot();
    return features[feature];
  }

  /** Oublie l'état mémorisé : la prochaine lecture interroge la base. */
  invalidate(): void {
    this.cached = null;
  }

  async set<K extends SettingKey>(
    key: K,
    value: SettingValue<K>,
    context: SettingChangeContext,
  ): Promise<void> {
    const parsed = settingSchema(key).safeParse(value);
    if (!parsed.success) {
      throw new AppError('UNPROCESSABLE_ENTITY', `Invalid value for setting "${key}".`, {
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      });
    }

    await this.unitOfWork.run(async (tx) => {
      const previous = await this.repository.lockAndFind(tx, key);
      const saved = await this.repository.save(tx, key, parsed.data);

      await this.audit.record(tx, {
        actor: context.actor,
        action: 'system_setting.updated',
        resource: { type: 'system_setting', id: key },
        outcome: 'SUCCESS',
        requestId: context.requestId,
        metadata: {
          previousValue: previous?.value ?? null,
          newValue: saved.value,
          version: saved.version,
          reason: context.reason ?? null,
        },
      });

      await this.outbox.append(tx, {
        aggregateType: 'system_setting',
        aggregateId: key,
        eventType: SYSTEM_SETTING_CHANGED_EVENT,
        payload: { key, version: saved.version },
        metadata: { requestId: context.requestId ?? null },
      });
    });

    this.invalidate();
  }

  setFeatureEnabled(
    feature: FeatureKey,
    enabled: boolean,
    context: SettingChangeContext,
  ): Promise<void> {
    return this.set(FEATURE_SETTING_KEYS[feature], enabled, context);
  }

  private async load(): Promise<SettingsSnapshot> {
    const stored = await this.repository.findAll();
    const snapshot = resolveSnapshot(
      new Map(stored.map((setting) => [setting.key, setting.value])),
      (key) => {
        this.logger.error(
          { settingKey: key },
          'Stored system setting is invalid; using its default',
        );
      },
    );
    this.cached = { snapshot, expiresAt: Date.now() + SNAPSHOT_TTL_MS };
    return snapshot;
  }
}
