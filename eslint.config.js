// @ts-check
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
    ignores: ["dist/**", "lib/**", "node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },
  {
    // Plain JavaScript helpers under tests/ (e.g. tests/fixtures/mock-canary.cjs,
    // the fake `stellar-canary` binary the whole test suite depends on). These
    // files match tseslint.configs.recommended's unscoped configs — which leak
    // TypeScript-aware rules onto them — but never the TS-specific block above,
    // so they previously got the wrong rule set or none at all. Re-disable the
    // leaked TS rules and lint them as what they are: CommonJS scripts.
    files: ["tests/**/*.{js,cjs}"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        // Runtime globals a plain CommonJS test fixture may use.
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        global: "readonly",
        // CommonJS module scope.
        require: "readonly",
        module: "writable",
        exports: "writable",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      // Undo the TS-aware rules the unscoped tseslint preset leaks here.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      // These files *are* CommonJS modules: `require()` is their module
      // system, not an interop shortcut.
      "@typescript-eslint/no-require-imports": "off",
      // Core equivalents for plain CommonJS scripts.
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-undef": "error",
      "no-var": "error",
      "prefer-const": "error",
      "no-console": "off",
    },
  },
);
