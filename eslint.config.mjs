import { globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const config = [
  globalIgnores([".next/**", "node_modules/**", "dist/**", "next-env.d.ts", "tmp/**", "public/workers/**"]),
  ...nextCoreWebVitals,
  ...nextTypeScript
];

export default config;
