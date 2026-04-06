import { readFileSync } from "fs";
import { resolve, relative } from "path";
import { globSync } from "glob";
import type { DiscoveredFile } from "./types.js";

const DEFAULT_INCLUDE = ["**/*.tsx", "**/*.jsx", "**/*.ts", "**/*.js"];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.config.*",
  "**/next.config.*",
  "**/postcss.config.*",
  "**/eslint.config.*",
  "**/tailwind.config.*",
];

export function discoverFiles(
  sourceDir: string,
  include = DEFAULT_INCLUDE,
  exclude = DEFAULT_EXCLUDE
): DiscoveredFile[] {
  const root = resolve(sourceDir);
  const paths = globSync(include, { cwd: root, ignore: exclude, absolute: true });

  return paths.map((filePath) => ({
    path: filePath,
    relativePath: relative(root, filePath),
    content: readFileSync(filePath, "utf-8"),
  }));
}
