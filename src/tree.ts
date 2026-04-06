import { resolve, dirname, join } from "path";
import { existsSync, readFileSync } from "fs";
import type { DiscoveredFile, ComponentAnalysis } from "./types.js";
import { analyzeComponent } from "./analyzer.js";

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

/**
 * Recursively resolve a component's imports and merge all analyses.
 * This follows local imports (./relative and @/ alias) to build a
 * complete picture of a page's interactive elements.
 */
export function analyzeComponentTree(
  rootFile: DiscoveredFile,
  allFiles: DiscoveredFile[],
  sourceRoot: string,
  maxDepth = 5
): ComponentAnalysis {
  const visited = new Set<string>();
  const allAnalyses: ComponentAnalysis[] = [];

  function walk(filePath: string, depth: number): void {
    if (depth > maxDepth || visited.has(filePath)) return;
    visited.add(filePath);

    const file = allFiles.find((f) => f.path === filePath);
    if (!file) return;

    const analysis = analyzeComponent(file.path, file.content);
    allAnalyses.push(analysis);

    // Follow local imports
    for (const importPath of analysis.imports) {
      const resolved = resolveImport(importPath, filePath, sourceRoot, allFiles);
      if (resolved) walk(resolved, depth + 1);
    }
  }

  walk(rootFile.path, 0);

  // Merge all analyses into one, with the root component's name
  return mergeAnalyses(allAnalyses, rootFile.path);
}

/**
 * Resolve an import path to an absolute file path.
 * Handles:
 *  - Relative imports: ./foo, ../bar
 *  - @/ alias (Next.js convention, maps to source root or src/)
 */
function resolveImport(
  importPath: string,
  fromFile: string,
  sourceRoot: string,
  allFiles: DiscoveredFile[]
): string | null {
  let basePath: string;

  if (importPath.startsWith("@/")) {
    // @/ alias → try source root, then source root + src/
    const stripped = importPath.slice(2);
    basePath = resolve(sourceRoot, stripped);
    // If not found at root, try src/ subdirectory (common in Next.js with src/ convention)
    if (!tryResolveFile(basePath, allFiles)) {
      const srcPath = resolve(sourceRoot, "src", stripped);
      if (tryResolveFile(srcPath, allFiles)) {
        basePath = srcPath;
      }
    }
  } else if (importPath.startsWith(".")) {
    basePath = resolve(dirname(fromFile), importPath);
  } else {
    return null; // node_modules or other
  }

  // Try with each extension
  for (const ext of EXTENSIONS) {
    const candidate = basePath + ext;
    if (allFiles.some((f) => f.path === candidate)) return candidate;
  }

  // Try as directory with index
  for (const ext of EXTENSIONS) {
    const candidate = join(basePath, `index${ext}`);
    if (allFiles.some((f) => f.path === candidate)) return candidate;
  }

  // Already has extension?
  if (allFiles.some((f) => f.path === basePath)) return basePath;

  return null;
}

/** Check if a basePath resolves to any known file (with extension or /index) */
function tryResolveFile(basePath: string, allFiles: DiscoveredFile[]): boolean {
  for (const ext of EXTENSIONS) {
    if (allFiles.some((f) => f.path === basePath + ext)) return true;
  }
  for (const ext of EXTENSIONS) {
    if (allFiles.some((f) => f.path === join(basePath, `index${ext}`))) return true;
  }
  return allFiles.some((f) => f.path === basePath);
}

/**
 * Merge multiple component analyses into one.
 * The root component's name and file are preserved.
 * All interactions, conditionals, API calls are combined.
 */
function mergeAnalyses(
  analyses: ComponentAnalysis[],
  rootFilePath: string
): ComponentAnalysis {
  const root = analyses.find((a) => a.filePath === rootFilePath) || analyses[0];

  // Combine source code from all files for LLM context
  const combinedSource = analyses
    .map((a) => `// === ${a.filePath} (${a.componentName}) ===\n${a.sourceCode}`)
    .join("\n\n");

  return {
    filePath: rootFilePath,
    componentName: root.componentName,
    sourceCode: combinedSource,
    interactions: analyses.flatMap((a) => a.interactions),
    conditionals: analyses.flatMap((a) => a.conditionals),
    apiCalls: analyses.flatMap((a) => a.apiCalls),
    imports: [...new Set(analyses.flatMap((a) => a.imports))],
  };
}
