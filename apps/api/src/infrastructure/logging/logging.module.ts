import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { AppConfig } from '../../config/app-config.js';
import { createLoggerParams } from './logger-options.js';

/** Journalisation structurée de toute l'application (requêtes HTTP et journaux applicatifs). */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => createLoggerParams(config),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
