import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./langfuse-read.mjs', import.meta.url));
const requests = [];
let host;
const server = createServer((request, response) => {
  requests.push({
    method: request.method,
    url: request.url,
    authorization: request.headers.authorization,
  });
  response.setHeader('Content-Type', 'application/json');
  if (request.url.includes('/missing')) {
    response.writeHead(404);
    response.end('{"message":"受控缺失"}');
  } else {
    response.end('{"data":[],"meta":{"cursor":null}}');
  }
});
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  host = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function run(args, overrides = {}) {
  try {
    const result = await exec(process.execPath, [script, ...args], {
      cwd: fileURLToPath(new URL('../apps', import.meta.url)),
      env: {
        ...process.env,
        LANGFUSE_HOST: host,
        LANGFUSE_BASE_URL: 'http://unwanted.invalid',
        LANGFUSE_PUBLIC_KEY: 'fixture-public',
        LANGFUSE_SECRET_KEY: 'fixture-secret',
        ...overrides,
      },
      timeout: 10000,
      windowsHide: true,
    });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('查询使用项目接入，传递版本参数和含斜杠名称，凭据不出现在输出', async () => {
  const result = await run(['prompts', 'get', 'turn/generate-system', '--version', '3', '--json']);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).status, 200);
  const request = requests.at(-1);
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/api/public/v2/prompts/turn%2Fgenerate-system?version=3');
  assert.equal(
    request.authorization,
    `Basic ${Buffer.from('fixture-public:fixture-secret').toString('base64')}`,
  );
  assert.ok(!`${result.stdout}${result.stderr}`.includes('fixture-secret'));
});

test('写操作、连接覆盖和密钥展示在发出请求前拒绝', async () => {
  const count = requests.length;
  for (const args of [
    ['prompts', 'create', '--name', 'test'],
    ['prompts', 'delete', 'test'],
    ['prompts', 'update-version', 'test', '1'],
    ['observations', 'list', '--host', host],
    ['observations', 'list', `--no-host=${host}`],
    ['observations', 'list', '--env=.env.local'],
    ['health', 'get', '--api-version=latest'],
    ['health', 'get', '--curl', '--show-secrets'],
    ['dataset-items', 'create', '--dataset-name', 'samples'],
    ['datasets', 'delete-run', 'samples', 'run'],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.ok(!`${result.stdout}${result.stderr}`.includes('fixture-secret'));
  }
  assert.equal(requests.length, count);
});

test('可以只读查询样本，不能由查询入口写入', async () => {
  const result = await run(['dataset-items', 'get', 'sample-1', '--json']);
  assert.equal(result.code, 0);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/public/dataset-items/sample-1');
});

test('缺少接入配置时停止，不回落到云端或本地文件中的其他值', async () => {
  const count = requests.length;
  for (const key of ['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
    const result = await run(['health', 'get'], { [key]: '' });
    assert.equal(result.code, 3);
  }
  assert.equal(requests.length, count);
});

test('保留官方 CLI 的 HTTP 失败退出码', async () => {
  const result = await run(['prompts', 'get', 'missing', '--json']);
  assert.equal(result.code, 5);
  assert.equal(JSON.parse(result.stdout).status, 404);
});

test('参数帮助不需要凭据，也不访问平台', async () => {
  const count = requests.length;
  const result = await run(['observations', 'list', '--help'], {
    LANGFUSE_HOST: '',
    LANGFUSE_PUBLIC_KEY: '',
    LANGFUSE_SECRET_KEY: '',
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--trace-id/);
  assert.equal(requests.length, count);
});
