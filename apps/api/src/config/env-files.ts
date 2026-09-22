import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 读仓库根目录那两份 .env：先 .env.local 后 .env。
 * loadEnvFile 不覆盖已经设过的键，密钥那份排在前面，后读的只能补空缺。
 *
 * 只有根目录一份（跟 .env.example 同级）。开发态的 src/config 与产物 dist/config 都在 apps/api 下两层，
 * 往上四级就是根，两种跑法落同一个文件。不能按 cwd 找：dev:api 走 pnpm --filter，cwd 是 apps/api。
 */
export function loadEnvFiles(): void {
  for (const name of ['.env.local', '.env']) {
    const envFile = resolve(__dirname, `../../../../${name}`);
    if (existsSync(envFile)) {
      process.loadEnvFile(envFile);
    }
  }
}
