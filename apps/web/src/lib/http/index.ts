import { createHttpClient } from './client';
export { ApiError, errorMessage, isCanceled, parseResponse } from './error';
export const http = createHttpClient({ baseURL: '/api', timeout: 30000 });
