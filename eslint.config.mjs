// ESLint flat config: @eslint/js + typescript-eslint (type-checked) + react-hooks, plus one local rule.
// Formatting is Prettier's job (see .prettierrc.json); no stylistic rules are enabled here.
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import ts from 'typescript'
import tseslint from 'typescript-eslint'

const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect'])

/**
 * `hangar/effect-cleanup-only`: an effect callback may return nothing or a cleanup function — never a value
 * (a promise from an async callback, a number, an object…). React treats any returned value as the cleanup and
 * calls it on unmount; a non-function there has already taken the whole window down once (Chromium 156).
 * Uses type information, so `() => setState(x)` (void) and `() => subscribe()` (returns a function) pass.
 */
const effectCleanupOnly = {
  meta: {
    type: 'problem',
    docs: { description: 'Effect callbacks must return nothing or a cleanup function' },
    messages: {
      async:
        'Effect callbacks must not be async: they would return a Promise as the cleanup. Call an async function inside instead.',
      value: 'Effect callbacks may only return a cleanup function (or nothing); this returns `{{type}}`.'
    },
    schema: []
  },
  create(context) {
    const services = context.sourceCode.parserServices
    if (!services?.program) return {}
    const checker = services.program.getTypeChecker()

    const allowed = (type) => {
      if (type.isUnion()) return type.types.every(allowed)
      const flags = type.getFlags()
      // any/unknown give no evidence either way; void/undefined/never mean "no cleanup".
      const none =
        ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never
      if (flags & none) return true
      return type.getCallSignatures().length > 0
    }

    const check = (node) => {
      const type = services.getTypeAtLocation(node)
      if (!allowed(type)) context.report({ node, messageId: 'value', data: { type: checker.typeToString(type) } })
    }

    return {
      CallExpression(call) {
        const callee = call.callee
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression'
              ? callee.property.name
              : undefined
        if (!EFFECT_HOOKS.has(name)) return
        const fn = call.arguments[0]
        if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) return
        if (fn.async) return context.report({ node: fn, messageId: 'async' })
        if (fn.body.type !== 'BlockStatement') return check(fn.body)
        // Return statements of this callback only (not of nested functions).
        const visit = (node) => {
          if (!node || typeof node.type !== 'string') return
          if (node !== fn.body && /Function/.test(node.type)) return
          if (node.type === 'ReturnStatement') {
            if (node.argument) check(node.argument)
            return
          }
          for (const key of Object.keys(node)) {
            if (key === 'parent') continue
            const child = node[key]
            if (Array.isArray(child)) child.forEach(visit)
            else if (child && typeof child.type === 'string') visit(child)
          }
        }
        visit(fn.body)
      }
    }
  }
}

export default tseslint.config(
  {
    ignores: ['out/**', 'release/**', 'dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**']
  },

  js.configs.recommended,

  // TypeScript everywhere, type-checked through the three tsconfigs.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json', './tests/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      // Existing `any` (JSON from outside, SDK payloads) is reported as a warning, not an error.
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      // Callbacks in props and zustand stores are declared with method shorthand (`onChange(v): void`) and never
      // use `this`; destructuring them is the normal React pattern, not an unbound method.
      '@typescript-eslint/unbound-method': 'off',
      // `async` without `await` keeps Promise-returning contracts (feature APIs, IPC handlers, test fakes) and turns
      // a throw into a rejection; removing it would change that behaviour.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }
      ]
    }
  },

  // Plain JS/CJS/MJS files (configs, build scripts) are not in any tsconfig: no type-aware rules there.
  {
    files: ['**/*.{js,cjs,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } }
  },

  // Main process, preload, shared code, tests and configs run on Node.
  {
    files: ['src/main/**', 'src/preload/**', 'src/shared/**', 'tests/**', '*.config.*', 'build/**', 'video/**'],
    languageOptions: { globals: { ...globals.node } }
  },

  // Renderer: browser globals, React hooks rules, and the effect-cleanup rule.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: {
      'react-hooks': reactHooks,
      hangar: { rules: { 'effect-cleanup-only': effectCleanupOnly } }
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'hangar/effect-cleanup-only': 'error'
    }
  }
)
