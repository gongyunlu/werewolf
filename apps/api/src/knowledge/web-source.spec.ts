import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import dns from 'node:dns/promises';
import http from 'node:http';
import { fetchWebPage, parseWebPage, publicAddress, publicLookup, sourceUrl } from './web-source';

const html =
  '<html><head><title>守卫攻略</title><meta property="article:published_time" content="2026-99-01" /></head><body><article><h1>守卫攻略</h1><p>根据板子规则讨论守救配合，不能把攻略意见当成当前对局中的事实。</p><p>先核对女巫是否可能使用解药，再结合守卫的限制决定守护对象。</p><script>globalThis.untrustedScript = true</script><img src="http://127.0.0.1/secret"></article></body></html>';
afterEach(() => jest.restoreAllMocks());

it('仅接受标准端口 HTTP(S)，阻止私网、映射地址与混合 DNS；解析也受超时约束', async () => {
  for (const url of ['file:///secret', 'http://user:pass@example.org', 'https://example.org:8080'])
    expect(() => sourceUrl(url)).toThrow();
  expect(sourceUrl('https://example.org:443/page#part')).toBe('https://example.org/page');
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '0.0.0.0',
    '100.64.0.1',
  ])
    expect(publicAddress(ip)).toBe(false);
  expect(publicAddress('8.8.8.8')).toBe(true);
  const lookup = jest.spyOn(dns, 'lookup').mockResolvedValue([
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ] as never);
  await expect(publicLookup('example.org')).rejects.toThrow('公开网络');
  lookup.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = publicLookup('example.org', controller.signal);
  controller.abort(new Error('DNS 超时'));
  await expect(pending).rejects.toThrow('DNS 超时');
});

it('提取纯文本与稳定段落，不运行网页脚本；哈希排除采集时间，无效日期留空', () => {
  const result = parseWebPage(html, 'https://example.org/guide');
  expect(result.title).toBe('守卫攻略');
  expect(result.paragraphs.some((p) => p.text.includes('女巫'))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('untrustedScript');
  expect(result.publishedOn).toBeNull();
  expect(result.hash).toBe(parseWebPage(html, result.url).hash);
  expect(() => parseWebPage('<html></html>', result.url)).toThrow('正文');
  expect(() =>
    parseWebPage(`<article><p>${'长文'.repeat(40000)}</p></article>`, result.url),
  ).toThrow('60000');
});

function transport(
  pages: Array<{ status?: number; headers?: Record<string, string>; body?: string }>,
) {
  jest
    .spyOn(dns, 'lookup')
    .mockImplementation(
      async (host) =>
        [{ address: host === 'internal.example' ? '127.0.0.1' : '8.8.8.8', family: 4 }] as never,
    );
  return jest.spyOn(http, 'request').mockImplementation(((
    url: URL,
    options: http.RequestOptions,
    callback: (message: http.IncomingMessage) => void,
  ) => {
    const page = pages.shift()!;
    expect(url.hostname).not.toBe('internal.example');
    const connection = new EventEmitter();
    Object.assign(connection, {
      end: () => {
        const response = Readable.from([Buffer.from(page.body ?? '')]);
        Object.assign(response, {
          statusCode: page.status ?? 200,
          headers: { 'content-type': 'text/html; charset=utf-8', ...page.headers },
        });
        callback(response as http.IncomingMessage);
      },
    });
    expect(options.signal).toBeDefined();
    return connection;
  }) as never);
}

it('逐跳检查并固定公网 IP；拒绝内网跳转、过多跳转、不支持类型、大响应和失败状态', async () => {
  const request = transport([{ body: html }]);
  expect((await fetchWebPage('http://example.org')).title).toBe('守卫攻略');
  const options = request.mock.calls[0]![1] as http.RequestOptions;
  const resolved = jest.fn();
  options.lookup!('example.org', { all: true }, resolved);
  expect(resolved).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
  request.mockRestore();
  transport([{ status: 302, headers: { location: 'http://internal.example/secret' } }]);
  await expect(fetchWebPage('http://example.org')).rejects.toThrow('公开网络');
  jest.restoreAllMocks();
  for (const [pages, message] of [
    [[{ status: 403 }], '403'],
    [[{ headers: { 'content-type': 'application/pdf' } }], 'HTML'],
    [[{ body: 'a'.repeat(2 * 1024 * 1024 + 1) }], '2 MB'],
    [Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/next' } })), '重定向'],
  ] as const) {
    transport([...pages]);
    await expect(fetchWebPage('http://example.org')).rejects.toThrow(message);
    jest.restoreAllMocks();
  }
});
