import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
// 字体走 JS 侧导入，让 Vite 接管 woff2 的解析与产物落盘
import '@fontsource-variable/geist';
import { router } from '@/router';
import { applyTheme, storedTheme } from '@/lib/theme';
import '@/index.css';

// 先落主题再渲染：晚一步会闪一下默认的浅色
applyTheme(storedTheme());

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('找不到挂载节点 #root');
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
