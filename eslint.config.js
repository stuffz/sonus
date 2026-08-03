import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // Only lint our TypeScript source; everything else is generated or vendored.
  {
    ignores: ["node_modules/", "dist/", "data/", "logs/", "patches/", "*.config.js"],
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Type-aware linting: let typescript-eslint discover the tsconfig automatically.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The no-unsafe-* family fires almost entirely on `any` values coming out of
      // JSON.parse() / response.json() — unavoidable without typing every payload.
      // High noise, low bug-value here, so we mute it and keep the linter's signal high.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Same root cause: `any`/unknown interpolated into template strings. Low value.
      "@typescript-eslint/restrict-template-expressions": "off",
      // Async functions are idiomatic as event-emitter / timer / collector handlers
      // (discord.js `.on()`, setTimeout, process signals) — fire-and-forget by design,
      // each with its own internal error handling. Keep every other void-return check.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
    },
  },
  // Must come last so it can turn off any stylistic rules that would fight Prettier.
  prettier,
);
