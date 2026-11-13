import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';
import { UnitOfWork } from './unit-of-work.js';

@Global()
@Module({
  providers: [PrismaService, UnitOfWork],
  exports: [PrismaService, UnitOfWork],
})
export class DatabaseModule {}
