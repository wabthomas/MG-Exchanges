import { Injectable } from '@nestjs/common';

import { ConcurrencyLimit } from '../../../common/http/concurrency-limit.js';
import { KYC_UPLOADS_IN_FLIGHT_MAX } from '../domain/kyc-policy.js';

/** Places de réception des pièces : au plus `KYC_UPLOADS_IN_FLIGHT_MAX` envois à la fois. */
@Injectable()
export class KycUploadSlots extends ConcurrencyLimit {
  constructor() {
    super(KYC_UPLOADS_IN_FLIGHT_MAX);
  }
}
