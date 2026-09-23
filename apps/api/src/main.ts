import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { loadEnv } from './config/env';
import { loadEnvFiles } from './config/env-files';

async function bootstrap() {
  loadEnvFiles();
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);

  // 统一挂在 /api 下，前端开发代理和线上同源部署都不用额外改写路径
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());
  // 退出时把队列与数据库收干净：worker 不关会在退出前接着领任务，连接不关要等对端超时。
  app.enableShutdownHooks();

  await app.listen(env.API_PORT);
  Logger.log(`API 已启动：http://localhost:${env.API_PORT}`, 'Bootstrap');
}

void bootstrap();
