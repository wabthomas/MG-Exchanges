import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';

import { ProblemDetailsFilter } from './common/http/problem-details.filter.js';
import { createValidationPipe } from './common/http/validation.pipe.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { LoggingModule } from './infrastructure/logging/logging.module.js';
import { QueueModule } from './infrastructure/queue/queue.module.js';
import { RateLimitModule } from './infrastructure/rate-limit/rate-limit.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { OutboxModule } from './modules/outbox/outbox.module.js';
import { SystemSettingsModule } from './modules/system-settings/system-settings.module.js';

/**
 * Racine du monolithe modulaire.
 *
 *  - socle technique : configuration, journalisation, PostgreSQL, Redis, files, limitation de débit ;
 *  - modules de plateforme : audit, boîte d'envoi, paramètres système, notifications, santé ;
 *  - modules métier : identité ; les suivants (portefeuilles, grand livre…) s'ajoutent ici
 *    phase après phase.
 *
 * L'ordre d'import fixe l'ordre des gardes globales : limitation de débit, maintenance,
 * authentification (refus par défaut), puis permissions.
 */
@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    RateLimitModule,
    AuditModule,
    OutboxModule,
    SystemSettingsModule,
    NotificationsModule,
    IdentityModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule {}
