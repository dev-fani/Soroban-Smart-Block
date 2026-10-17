import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import designTokensRule from "./eslint-rules/design-tokens.js";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Hook call order and stale-closure dependency bugs (#978).
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "design-tokens/enforce": ["error", {
        allowedFiles: [
          "**/ContractDependencyGraph3D.tsx",
          "**/AddressConnectionGraph.tsx",
          "**/DependencyVisualizer.tsx",
          "**/FileExplorer.tsx",
          "**/Editor.tsx",
          "**/Terminal.tsx",
          "**/*.test.{ts,tsx}",
          "**/*.stories.{ts,tsx}",
          "**/eslint-rules/**",
        ],
      }],
    },
    plugins: {
      "react-hooks": reactHooks,
      "design-tokens": {
        rules: {
          enforce: designTokensRule,
        },
      },
    },
  },
  {
    files: [      "src/components/AddressConnectionGraph.tsx", "src/components/ContractDependencyGraph3D.tsx", "src/components/DependencyVisualizer.tsx", "src/components/FileExplorer.tsx", "src/components/RawDataViewer.tsx", "src/components/ReadContract.tsx", "src/components/SimulateButton.tsx", "src/components/WriteContract.tsx", "src/pages/ContractPage.tsx", "src/pages/RpcMetricsDashboard.tsx", "src/pages/SandboxPage.tsx", "src/pages/SetupPage.tsx", "src/pages/XdrInspector.tsx", "src/services/dependencies.ts", "src/services/sandbox-api.ts", "src/services/webcontainer.ts", "src/env.d.ts", "test/api.test.ts", "test/hooks.test.tsx", "test/ErrorBoundary.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    ignores: ["node_modules/**", "dist/**"],
  },
];
