import { Global, Module } from '@nestjs/common';

import { AppConfig, loadAppConfig } from './app-config.js';

/** Fournit la configuration validée ({@link AppConfig}) à toute l'application. */
@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: (): AppConfig => loadAppConfig() }],
  exports: [AppConfig],
})
export class ConfigModule {}
