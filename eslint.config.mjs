// Root ESLint flat config for the whole monorepo. Run with `pnpm lint` (or `pnpm lint:fix`).
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const root = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = resolve(root, 'apps/api/src/modules');

/** Name of the api module a file belongs to, or null. */
function moduleOf(absPath) {
  const rel = relative(MODULES_DIR, absPath);
  if (rel.startsWith('..') || rel === '') return null;
  return rel.split(sep)[0];
}

/**
 * procure/module-boundaries: a file in apps/api/src/modules/<x> may import another module <y>
 * only through its public entry point (modules/<y> or modules/<y>/index). Deep imports such as
 * '../inventory/stock.service' are errors. Applies to import, export-from, dynamic import and require.
 */
const moduleBoundaries = {
  meta: {
    type: 'problem',
    docs: { description: 'Cross-module imports must go through the target module index.ts' },
    schema: [],
    messages: {
      deep: "Module '{{from}}' must import module '{{to}}' via its index ('{{entry}}'), not '{{source}}'.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const from = moduleOf(filename);
    if (!from) return {};
    function check(node, source) {
      if (typeof source !== 'string' || !source.startsWith('.')) return;
      const target = resolve(dirname(filename), source);
      const to = moduleOf(target);
      if (!to || to === from) return;
      const inner = relative(resolve(MODULES_DIR, to), target).split(sep).join('/');
      if (inner === '' || inner === 'index' || inner === 'index.js' || inner === 'index.ts') return;
      context.report({
        node,
        messageId: 'deep',
        data: { from, to, source, entry: relative(dirname(filename), resolve(MODULES_DIR, to)).split(sep).join('/') },
      });
    }
    return {
      ImportDeclaration: n => check(n.source, n.source.value),
      ExportNamedDeclaration: n => n.source && check(n.source, n.source.value),
      ExportAllDeclaration: n => check(n.source, n.source.value),
      ImportExpression: n => n.source.type === 'Literal' && check(n.source, n.source.value),
      'CallExpression[callee.name="require"]': n =>
        n.arguments[0]?.type === 'Literal' && check(n.arguments[0], n.arguments[0].value),
    };
  },
};

const procure = { rules: { 'module-boundaries': moduleBoundaries } };

// Platform-role (BYPASSRLS) access is confined to these folders (ADR-0002).
const PLATFORM_ALLOWED = [
  'apps/api/src/modules/platform/**',
  'apps/api/src/modules/identity/**',
  'apps/api/src/core/**',
  'apps/api/src/seed/**',
  // Phase 3 core-level jobs in the documents module: audit-chain verifier (+ audit check reads, impersonator names)
  // and the outbox relay / tenant fiscal-year read.
  'apps/api/src/modules/documents/audit/**',
  'apps/api/src/modules/documents/system/**',
  // Phase 6 templates: read-only tenant profile (legal name, GSTIN, address, logo) for document templates.
  'apps/api/src/modules/templates/system/**',
  // Phase 6 notify: provider credentials / WhatsApp catalogue (platform tables), Super Admin endpoints and inbound
  // provider webhooks (status lookup by provider message id across tenants).
  'apps/api/src/modules/notify/platform/**',
];
const PLATFORM_MSG =
  'Platform (BYPASSRLS) DB access is only allowed in modules/platform, modules/identity, core, seed and modules/documents/{audit,system}. Use db.tenantTx() instead.';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.dist-*/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
      'infra/terraform/**/.terraform/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { procure },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-globals': ['error', { name: 'eval', message: 'eval is banned.' }],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Function']", message: 'new Function() is banned.' },
        { selector: "CallExpression[callee.name='Function']", message: 'Function() constructor is banned.' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['apps/api/src/modules/**/*.ts'],
    rules: { 'procure/module-boundaries': 'error' },
  },
  {
    // Everything in the API outside the allowed folders: no platformTx / db.platform.
    files: ['apps/api/src/**/*.ts'],
    ignores: PLATFORM_ALLOWED,
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Function']", message: 'new Function() is banned.' },
        { selector: "CallExpression[callee.name='Function']", message: 'Function() constructor is banned.' },
        { selector: "MemberExpression[property.name='platformTx']", message: PLATFORM_MSG },
        { selector: "MemberExpression[property.name='platformDb']", message: PLATFORM_MSG },
        // db.platform / this.db.platform / dbService.platform / this.dbService.platform
        {
          selector: "MemberExpression[property.name='platform'][object.name=/^(db|dbService|dbs)$/]",
          message: PLATFORM_MSG,
        },
        {
          selector: "MemberExpression[property.name='platform'][object.property.name=/^(db|dbService|dbs)$/]",
          message: PLATFORM_MSG,
        },
        // destructuring: const { platformTx } = db
        {
          selector: "Property[key.name=/^(platformTx|platformDb)$/][parent.type='ObjectPattern']",
          message: PLATFORM_MSG,
        },
      ],
    },
  },
  {
    // Nest uses classes with only decorators/static members, and empty constructors for DI.
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx,js,jsx}', 'packages/ui/**/*.{ts,tsx,js,jsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
);
