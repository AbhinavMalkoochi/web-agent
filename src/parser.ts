import { parse } from "@babel/parser";
import type { File } from "@babel/types";

const BABEL_PLUGINS = [
  "jsx",
  "typescript",
  "decorators-legacy",
  "classProperties",
  "optionalChaining",
  "nullishCoalescingOperator",
  "dynamicImport",
  "exportDefaultFrom",
] as const;

export function parseSource(code: string, filePath: string): File {
  return parse(code, {
    sourceType: "module",
    sourceFilename: filePath,
    plugins: [...BABEL_PLUGINS],
    errorRecovery: true,
  });
}
