import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from '../app.module.js';
import { configureApp, initializeApp, NEST_APPLICATION_OPTIONS } from './configure-app.js';

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, NEST_APPLICATION_OPTIONS);
  configureApp(app);
  await initializeApp(app);
  return app;
}
