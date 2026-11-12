import { Module } from '@nestjs/common';

import { AuditService } from './application/audit.service.js';
import { AuditTrailReader } from './application/audit-trail.reader.js';

@Module({
  providers: [AuditService, AuditTrailReader],
  exports: [AuditService, AuditTrailReader],
})
export class AuditModule {}
