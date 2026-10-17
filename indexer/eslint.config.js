import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,

  // ── Application + test source (ESM) ────────────────────────────────────────
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // ── SSRF (#928): all outbound HTTP must go through src/safeHttp.js ──────────
  {
    files: ["src/**/*.js"],
    ignores: ["src/safeHttp.js", "src/optional/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Use safeFetch from src/safeHttp.js for outbound requests (SSRF, #928)." },
      ],
      "no-restricted-properties": [
        "error",
        ...["http", "https"].flatMap((object) =>
          ["request", "get"].map((property) => ({
            object,
            property,
            message: "Use safeFetch from src/safeHttp.js for outbound requests (SSRF, #928).",
          })),
        ),
        { object: "globalThis", property: "fetch", message: "Use safeFetch from src/safeHttp.js (SSRF, #928)." },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: ["axios", "node-fetch", "undici", "got"].map((name) => ({
            name,
            message: "Use safeFetch from src/safeHttp.js for outbound requests (SSRF, #928).",
          })),
        },
      ],
    },
  },

  // ── Test files: add the test-runner globals (jest + node:test share names) ──
  {
    files: ["test/**/*.js", "tests/**/*.js", "**/*.test.js"],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },

  // ── CommonJS: legacy pg-migrate migrations ──────────────────────────────────
  {
    files: ["migrations/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
  },

  {
    ignores: ["node_modules/**", "coverage/**", "reports/**"],
  },
];
