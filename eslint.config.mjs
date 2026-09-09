import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Node.js builtin modules (bare specifiers; the `node:*` pattern covers the
// prefixed form). The renderer runs with nodeIntegration: false and
// sandbox: true, so importing any of these is a security-baseline violation.
const nodeBuiltins = [
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // TASK-002: the renderer must never touch Node APIs or Electron internals;
    // it talks to the main process through window.teskra (contextBridge) only.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'Renderer must not import electron; use the window.teskra bridge instead.',
            },
            ...nodeBuiltins.map((name) => ({
              name,
              message: `Renderer must not import Node builtin "${name}"; go through window.teskra IPC.`,
            })),
          ],
          patterns: [
            {
              group: ['node:*'],
              message:
                'Renderer must not import Node builtins (node:*); go through window.teskra IPC.',
            },
            {
              // TASK-003: Renderer → Preload → Main layering; the renderer
              // must never reach into main/preload process code directly.
              group: ['**/main/**', '**/preload/**'],
              message:
                'Renderer must not import apps/desktop/src/main|preload code; use window.teskra IPC.',
            },
          ],
        },
      ],
    },
  },
  {
    // TASK-003: @teskra/contracts is bundled into the sandboxed preload
    // (which may only require `electron`), so it must not import Node
    // builtins or electron itself.
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'contracts must not import electron; it is bundled into the preload.',
            },
            ...nodeBuiltins.map((name) => ({
              name,
              message: `contracts must not import Node builtin "${name}"; it is bundled into the sandboxed preload.`,
            })),
          ],
          patterns: [
            {
              group: ['node:*'],
              message: 'contracts must not import Node builtins (node:*).',
            },
          ],
        },
      ],
    },
  },
  {
    // TASK-078 + TASK-010 boundary rules. One block because flat config lets
    // only the last matching block's options win for a given rule name.
    //
    // TASK-078: all data-root paths come from src/main/paths.ts (ADR-0003);
    // nobody else may hand-build a ".teskra" path.
    // TASK-010: platform branching lives in the WorkspaceRuntime abstraction
    // (main/workspace/runtime.ts); Agent / Git / Terminal / Manager code must
    // not scatter process.platform checks.
    //
    // Exempt: paths.ts (the path authority), runtime.ts (the platform
    // authority), main/index.ts (the Electron app-lifecycle darwin check),
    // and tests (which parameterize host-dependent scenarios).
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    ignores: [
      'apps/desktop/src/main/paths.ts',
      'apps/desktop/src/main/workspace/runtime.ts',
      'apps/desktop/src/main/index.ts',
      'apps/desktop/src/**/*.test.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/\\.teskra/]',
          message:
            'Do not hand-build ".teskra" paths; use apps/desktop/src/main/paths.ts (ADR-0003).',
        },
        {
          selector: 'TemplateElement[value.raw=/\\.teskra/]',
          message:
            'Do not hand-build ".teskra" paths; use apps/desktop/src/main/paths.ts (ADR-0003).',
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='platform']",
          message:
            'Do not branch on process.platform; use the WorkspaceRuntime abstraction (apps/desktop/src/main/workspace/runtime.ts, TASK-010).',
        },
      ],
    },
  },
  {
    // Test files run under Vitest (Node) and are exempt — the runtime check
    // for shipped modules lives in src/no-node-builtins.test.ts.
    files: ['packages/contracts/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
)
