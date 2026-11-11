import { Module } from '@nestjs/common';

import { AuditService } from './application/audit.service.js';

@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
