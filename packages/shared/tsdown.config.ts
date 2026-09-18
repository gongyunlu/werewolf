import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  // 后端走 CJS、前端走 ESM，两种格式都要出；
  // 扩展名交给 tsdown 的 fixedExtension 默认值（.mjs / .cjs），避免两种格式同名互相覆盖
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
});
