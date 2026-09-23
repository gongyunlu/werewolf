/** 头名与后端守卫里那一个对齐。 */
const HEADER = 'x-admin-token';

const STORAGE_KEY = 'werewolf:admin-token';

/** 管理令牌存在本机，不在库里也不进代码。没填过就是空串。 */
export function storedAdminToken(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}

export function saveAdminToken(token: string): void {
  if (token === '') {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, token);
  }
}

/** 写请求带的那一个头。没填就什么都不带——后端会拒，由它去说为什么。 */
export function adminHeaders(): Record<string, string> {
  const token = storedAdminToken();

  return token === '' ? {} : { [HEADER]: token };
}
