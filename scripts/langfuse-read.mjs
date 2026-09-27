import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const commands = new Set([
  'health get',
  'observations list',
  'prompts list',
  'prompts get',
  'metrics get',
  'models list',
  'models get',
  'datasets list',
  'datasets get',
  'dataset-items list',
  'dataset-items get',
]);
const args = process.argv.slice(2);

function main() {
  if (!args.length || ['--help', '-h', 'help'].includes(args[0])) {
    console.log(`用法：pnpm langfuse:read <资源> <操作> [官方 CLI 参数]
只读命令：${[...commands].join('、')}
查看参数：pnpm langfuse:read observations list --help
连接读取项目根目录 .env.local 和 .env，已有进程环境变量优先。
调用链使用 observations list --trace-id 查询。`);
    return;
  }
  // 固定查询入口和接入配置，禁止借全局参数切换目的地或打印密钥。
  const blocked = new Set([
    'host',
    'env',
    'public-key',
    'secret-key',
    'api-version',
    'show-secrets',
  ]);
  if (
    !commands.has(`${args[0]} ${args[1]}`) ||
    args.some(
      (arg) => arg.startsWith('--') && blocked.has(arg.replace(/^--(?:no-)?/, '').split('=')[0]),
    )
  ) {
    console.error('该入口只允许列出的查询命令，不接受连接覆盖、API 版本覆盖或密钥展示参数。');
    process.exitCode = 2;
    return;
  }
  const help = ['help', '--help', '-h'].includes(args[2]);
  if (!help) {
    for (const name of ['.env.local', '.env']) {
      const path = new URL(`../${name}`, import.meta.url);
      if (existsSync(path)) process.loadEnvFile(fileURLToPath(path));
    }
    if (
      !process.env.LANGFUSE_HOST ||
      !process.env.LANGFUSE_PUBLIC_KEY ||
      !process.env.LANGFUSE_SECRET_KEY
    ) {
      console.error('请配置 LANGFUSE_HOST、LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY。');
      process.exitCode = 3;
      return;
    }
  }
  const cli = fileURLToPath(import.meta.resolve('@langfuse/cli/bin/langfuse.mjs'));
  // CLI 尚无 4.15 快照；使用已验证兼容当前部署的 4.10 查询契约。
  const child = spawnSync(process.execPath, [cli, '--api-version', '4.10.0', 'api', ...args], {
    env: { ...process.env, LANGFUSE_BASE_URL: process.env.LANGFUSE_HOST },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (child.error) console.error('无法启动 Langfuse CLI。');
  process.exitCode = child.status ?? 1;
}

try {
  main();
} catch {
  console.error('Langfuse 查询入口启动失败，请检查环境文件与依赖安装。');
  process.exitCode = 6;
}
