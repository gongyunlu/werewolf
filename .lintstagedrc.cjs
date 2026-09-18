module.exports = {
  'apps/api/**/*.{ts,js,mjs,cjs}': [
    'prettier --write',
    'pnpm --filter @werewolf/api lint:fix',
    () => 'pnpm --filter @werewolf/api typecheck',
  ],
  'apps/web/**/*.{ts,tsx,js,jsx,mjs,cjs}': [
    'prettier --write',
    'pnpm --filter @werewolf/web lint:fix',
    () => 'pnpm --filter @werewolf/web typecheck',
  ],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};
