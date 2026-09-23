import { ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
/** 主密钥 32 字节，写成十六进制就是 64 位。 */
const KEY_HEX_LENGTH = 64;
const IV_BYTES = 12;
/** 密文格式的版本段。换算法时靠它认出老行，不至于把上一版的密文当这一版解。 */
const VERSION = 'v1';

/**
 * 把主密钥读成 32 字节。只认 64 位十六进制一种写法。
 * 长度不对当场抛：配错要停在第一次用到它的地方，不能等到密钥存进库了才发现解不开。
 */
function masterKey(secretKey: string): Buffer {
  if (secretKey.length !== KEY_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(secretKey)) {
    throw new Error('AGENT_SECRET_KEY 得是 64 位十六进制（32 字节）');
  }

  return Buffer.from(secretKey, 'hex');
}

/**
 * 加密一把 agent 自带密钥。同一段明文每次密文都不同——IV 是现取的，库里看不出两把是不是同一把。
 * 格式：v1.<IV>.<认证标签>.<密文>，后三段都是 base64。
 */
export function encryptAgentSecret(plain: string, secretKey: string): string {
  const key = masterKey(secretKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    sealed.toString('base64'),
  ].join('.');
}

/**
 * 解回明文。
 * 密文被改过、或者换了主密钥，都会在认证标签那一步抛——这两件事都不该被当成「读到了空密钥」放过去。
 */
export function decryptAgentSecret(ciphertext: string, secretKey: string): string {
  const parts = ciphertext.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`认不出的密钥密文：段数或版本对不上`);
  }

  const [, iv, tag, sealed] = parts;
  const decipher = createDecipheriv(ALGORITHM, masterKey(secretKey), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));

  return Buffer.concat([decipher.update(Buffer.from(sealed, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/** 一对加解密函数：调用方只管用，主密钥从哪儿来它不管。 */
export interface AgentSecretCrypto {
  encrypt(plain: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * 按环境变量里那份主密钥交出一对加解密函数。
 * 没配就抛：用到它的两处（存密钥、开局取密钥）都是正要碰密钥的时候，这时候不能装作没这回事。
 * 报的是 503 不是普通错误——缺的是服务端的配置，不是请求有问题，跟 ADMIN_TOKEN 没配时一个口径。
 */
export function agentSecretCrypto(secretKey: string): AgentSecretCrypto {
  if (secretKey === '')
    throw new ServiceUnavailableException('没配 AGENT_SECRET_KEY，用不了 agent 自带密钥');

  return {
    encrypt: (plain) => encryptAgentSecret(plain, secretKey),
    decrypt: (ciphertext) => decryptAgentSecret(ciphertext, secretKey),
  };
}
