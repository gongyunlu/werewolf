// @vitest-environment node
import { once } from 'node:events';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { createServer, type ProxyOptions } from 'vite';
import { expect, it } from 'vitest';
import config from '../../vite.config';

it('事件流中断或后端离线时关闭代理连接，普通请求仍返回 502', async () => {
  let upstreamResponse: ServerResponse;
  const upstream = createHttpServer((_request, response) => {
    upstreamResponse = response;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('id: 1\ndata: 已连接\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const upstreamPort = (upstream.address() as AddressInfo).port;
  const server = await createServer({
    configFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: null,
      proxy: {
        '/api': {
          ...(config.server!.proxy!['/api'] as ProxyOptions),
          target: `http://127.0.0.1:${upstreamPort}`,
        },
      },
    },
  });
  const controller = new AbortController();

  try {
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('已连接');

    upstreamResponse!.destroy();
    const disconnected = reader.read().then(
      ({ done }) => done,
      () => true,
    );
    expect(await Promise.race([disconnected, setTimeout(1000, false)])).toBe(true);

    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await expect(
      fetch(`http://127.0.0.1:${port}/api/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect((await fetch(`http://127.0.0.1:${port}/api/status`)).status).toBe(502);
  } finally {
    controller.abort();
    upstream.closeAllConnections();
    await Promise.all([
      server.close(),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});
