import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// 跟 main.ts 同一套：仓库根目录下 .env.local 读在前、.env 补空缺。
// 往上两级是根，源码和产物两种跑法落同一个文件。
for (const name of ['.env.local', '.env']) {
  const envFile = resolve(__dirname, `../../${name}`);
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

export default defineConfig({
  // 生成客户端不连库，所以这儿不拦缺失：真连库的命令缺了会由 Prisma 自己报。
  // 拦在这儿会让一台还没配 .env.local 的机器连 pnpm install 都装不完。
  datasource: { url: process.env['DATABASE_URL'] ?? '' },
});
