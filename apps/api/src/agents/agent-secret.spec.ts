import { decryptAgentSecret, encryptAgentSecret } from './agent-secret';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

describe('agent 密钥加解密', () => {
  it('加完再解回来是原文', () => {
    const plain = 'sk-中文密钥-🔑-with-mixed_Chars.123';

    expect(decryptAgentSecret(encryptAgentSecret(plain, KEY), KEY)).toBe(plain);
  });

  it('同一段明文两次加密结果不同', () => {
    expect(encryptAgentSecret('sk-same', KEY)).not.toBe(encryptAgentSecret('sk-same', KEY));
  });

  it('密文里读不出明文', () => {
    expect(encryptAgentSecret('sk-secret-value', KEY)).not.toContain('sk-secret-value');
  });

  it('换了主密钥解不开', () => {
    const ciphertext = encryptAgentSecret('sk-x', KEY);

    expect(() => decryptAgentSecret(ciphertext, OTHER_KEY)).toThrow();
  });

  it('密文被改过一个字符就解不开', () => {
    const ciphertext = encryptAgentSecret('sk-x', KEY);
    const tampered = ciphertext.slice(0, -2) + (ciphertext.endsWith('A') ? 'BB' : 'AA');

    expect(() => decryptAgentSecret(tampered, KEY)).toThrow();
  });

  it('主密钥不是 64 位十六进制时加密与解密都当场抛', () => {
    expect(() => encryptAgentSecret('sk-x', 'tooshort')).toThrow(/AGENT_SECRET_KEY/);
    expect(() => decryptAgentSecret(encryptAgentSecret('sk-x', KEY), 'tooshort')).toThrow(
      /AGENT_SECRET_KEY/,
    );
  });

  it('段数或版本对不上当场抛', () => {
    expect(() => decryptAgentSecret('v2.a.b.c', KEY)).toThrow(/认不出的密钥密文/);
    expect(() => decryptAgentSecret('v1.a.b', KEY)).toThrow(/认不出的密钥密文/);
  });
});
