import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { loadEnv } from './config/env';

// .env 只放在仓库根目录（.env.example 所在的同级）。开发态 src 与构建产物 dist
// 都在 apps/api 下一层，向上三级即仓库根，两种运行方式都能落到同一个文件。
// 不能按 cwd 找：dev:api 由 pnpm --filter 执行，cwd 是 apps/api。
const envFile = resolve(__dirname, '../../../.env');

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);

  // 统一挂在 /api 下，前端开发代理与线上同源部署都不用额外改写路径
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());

  await app.listen(env.API_PORT);
  Logger.log(`API 已启动：http://localhost:${env.API_PORT}`, 'Bootstrap');
}

void bootstrap();
