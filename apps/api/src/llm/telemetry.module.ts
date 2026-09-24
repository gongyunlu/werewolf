import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { startTelemetry, stopTelemetry } from './telemetry';

@Module({})
export class TelemetryModule implements OnApplicationShutdown {
  constructor() {
    startTelemetry(loadEnv());
  }
  onApplicationShutdown(): Promise<void> {
    return stopTelemetry();
  }
}
