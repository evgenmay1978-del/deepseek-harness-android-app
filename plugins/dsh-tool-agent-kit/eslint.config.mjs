/**
 * Статический барьер плагина: только no-undef и no-use-before-define.
 * ЗАЧЕМ: 04.10.2026 тихий ReferenceError (замыкание на block-scoped store) не поймали
 * 123 зелёных теста и прошёл деплой; эти два правила ловят класс сразу.
 * Конфиг живёт в репозитории, версия eslint зафиксирована в devDependencies.
 */
const nodeGlobals = {
  process: "readonly", console: "readonly", Buffer: "readonly", globalThis: "readonly",
  setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
  setImmediate: "readonly", clearImmediate: "readonly", queueMicrotask: "readonly",
  URL: "readonly", URLSearchParams: "readonly", TextEncoder: "readonly", TextDecoder: "readonly",
  structuredClone: "readonly", fetch: "readonly", AbortController: "readonly", AbortSignal: "readonly",
  performance: "readonly", atob: "readonly", btoa: "readonly",
};

export default [
  {
    files: ["**/*.js", "**/*.mjs"],
    ignores: ["node_modules/**"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: nodeGlobals },
    rules: {
      "no-undef": "error",
      "no-use-before-define": ["error", { functions: false, classes: true, variables: true, allowNamedExports: true }],
    },
  },
];
