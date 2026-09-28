import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import ipaddr from 'ipaddr.js';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { WebSnapshotSchema, type WebSnapshot } from '@werewolf/shared';

const MAX_BYTES = 2 * 1024 * 1024;
export function sourceUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
    throw new Error('仅支持不含凭据、使用标准端口的 HTTP(S) 网页');
  url.hash = '';
  if (url.href.length > 600) throw new Error('网页链接过长');
  return url.href;
}
export function publicAddress(value: string): boolean {
  try {
    return ipaddr.process(value).range() === 'unicast';
  } catch {
    return false;
  }
}
export async function publicLookup(hostname: string, signal = AbortSignal.timeout(20_000)) {
  const host = hostname.replace(/^\[|\]$/g, '');
  signal.throwIfAborted();
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void lookup(host, { all: true, verbatim: true })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
    throw new Error('采集地址必须解析到公开网络，不能访问内网或保留地址');
  return addresses[0]!;
}

/** 每次跳转重新检查 DNS，并把通过检查的 IP 固定到实际连接。 */
export async function fetchWebPage(value: string): Promise<WebSnapshot> {
  let url = new URL(sourceUrl(value));
  const signal = AbortSignal.timeout(20_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const address = await publicLookup(url.hostname, signal);
    const options: RequestOptions = {
      signal,
      headers: {
        'User-Agent': 'WerewolfKnowledge/1.0',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'identity',
      },
      lookup: (_host, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    };
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        options,
        resolve,
      );
      request.on('error', reject);
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      response.destroy();
      if (!response.headers.location || redirects === 3)
        throw new Error('网页重定向次数过多或缺少目标');
      url = new URL(sourceUrl(new URL(response.headers.location, url).href));
      continue;
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error(`网页返回 HTTP ${response.statusCode}`);
    }
    const type = response.headers['content-type'] ?? '';
    if (
      !/^text\/html|^application\/xhtml\+xml/i.test(type) ||
      (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
    ) {
      response.destroy();
      throw new Error('只支持直接返回 HTML 正文的网页');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        response.destroy();
        throw new Error('网页超过 2 MB 采集上限');
      }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const charset =
      /charset\s*=\s*["']?([\w-]+)/i.exec(type)?.[1] ??
      /charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString('ascii'))?.[1] ??
      'utf-8';
    return parseWebPage(new TextDecoder(charset).decode(bytes), url.href);
  }
  throw new Error('无法完成网页采集');
}

export function parseWebPage(html: string, url: string): WebSnapshot {
  // 不启用脚本和外部资源；预览只返回文本，不返回页面 HTML。
  const dom = new JSDOM(html, { url });
  try {
    const article = new Readability(dom.window.document, { maxElemsToParse: 30_000 }).parse();
    if (!article?.textContent?.trim())
      throw new Error('没有提取到文章正文，请使用公开的静态文章页');
    const textDom = new JSDOM(article.content ?? '');
    let texts: string[];
    try {
      texts = [...textDom.window.document.querySelectorAll('h1,h2,h3,h4,p,li,pre,blockquote,td')]
        .filter((node) => !node.querySelector('p,li,pre,blockquote,td'))
        .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    } finally {
      textDom.window.close();
    }
    if (!texts.length)
      texts = article.textContent
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (texts.join('\n').length > 60_000)
      throw new Error('正文超过 60000 字采集上限，请选择更短的文章');
    const paragraphs = texts
      .flatMap((text) => text.match(/[\s\S]{1,1500}/g) ?? [])
      .map((text, index) => ({ id: `P${index + 1}`, text }));
    if (!paragraphs.length || paragraphs.length > 500) throw new Error('正文段落数量不受支持');
    const content = {
      title: (article.title ?? '').trim().slice(0, 160) || new URL(url).hostname,
      publisher: new URL(url).hostname,
      author: (article.byline ?? '').trim().slice(0, 80),
      publishedOn:
        WebSnapshotSchema.shape.publishedOn.safeParse(article.publishedTime?.slice(0, 10)).data ??
        null,
      paragraphs,
    };
    return {
      ...content,
      url,
      fetchedAt: new Date().toISOString(),
      hash: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    };
  } finally {
    dom.window.close();
  }
}
