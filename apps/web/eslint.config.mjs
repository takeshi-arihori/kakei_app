import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // eslint-config-nextの既定Ignoreを上書きする。
  globalIgnores([
    // eslint-config-nextの既定Ignore:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/shared/graphql/generated.ts",
  ]),
]);

export default eslintConfig;
