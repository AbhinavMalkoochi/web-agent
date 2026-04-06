import { resolve } from "path";
import { readFileSync } from "fs";
import { discoverFiles } from "./discovery.js";
import { extractNextRoutes } from "./routes.js";
import { analyzeComponentTree } from "./tree.js";
import { describeRoute, fallbackDescription } from "./llm.js";
import { compileBrowserTxt, writeBrowserTxt, summarize } from "./compiler.js";
import type { CrawlerConfig, PageDescription } from "./types.js";

/**
 * Main analysis pipeline.
 *
 * 1. Discover source files
 * 2. Extract routes (Next.js App Router)
 * 3. Analyze each route's component (AST extraction)
 * 4. Send to LLM for semantic descriptions (or fallback)
 * 5. Compile into browser.txt
 */
export async function analyze(config: CrawlerConfig): Promise<void> {
  const sourceDir = resolve(config.sourceDir);
  console.log(`\n🔍 Scanning ${sourceDir}...\n`);

  // 1. Discover files
  const files = discoverFiles(sourceDir, config.include, config.exclude);
  console.log(`   Found ${files.length} source files`);

  // 2. Extract routes
  const routes = extractNextRoutes(files, sourceDir);
  console.log(`   Found ${routes.length} routes:\n`);
  for (const route of routes) {
    console.log(`   ${route.isDynamic ? "⚡" : "📄"} ${route.path} → ${route.componentName}`);
  }
  console.log("");

  // 3. Analyze each route's component tree (follows imports recursively)
  const analyses = routes.map((route) => {
    const file = files.find((f) => f.path === route.filePath);
    if (!file) return null;
    console.log(`   Analyzing ${route.path}...`);
    return { route, analysis: analyzeComponentTree(file, files, sourceDir) };
  }).filter(Boolean) as Array<{ route: typeof routes[0]; analysis: ReturnType<typeof analyzeComponentTree> }>;

  // 4. LLM enrichment (or AST-only fallback)
  const pages: PageDescription[] = [];

  if (config.skipLlm || !config.openaiApiKey) {
    if (!config.skipLlm && !config.openaiApiKey) {
      console.log("\n⚠️  No OPENAI_API_KEY found. Running AST-only analysis (use --api-key or set OPENAI_API_KEY).\n");
    } else {
      console.log("\n📋 AST-only mode (--no-llm)\n");
    }

    for (const { route, analysis } of analyses) {
      pages.push(fallbackDescription(route, analysis));
    }
  } else {
    console.log(`\n🤖 Sending ${analyses.length} pages to LLM (${config.model})...\n`);

    for (const { route, analysis } of analyses) {
      process.stdout.write(`   Describing ${route.path}...`);
      const page = await describeRoute(route, analysis, config.openaiApiKey, config.model);
      pages.push(page);
      console.log(` ✓ (${page.interactions.length} interactions)`);
    }
  }

  // 5. Compile and write
  const siteName = deriveProjectName(sourceDir);
  const browserTxt = compileBrowserTxt(pages, siteName);
  const outputPath = resolve(config.output);
  writeBrowserTxt(browserTxt, outputPath);

  console.log(summarize(browserTxt));
  console.log(`   Written to: ${outputPath}\n`);
}

function deriveProjectName(sourceDir: string): string {
  try {
    const pkgPath = resolve(sourceDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.name || "Unknown";
  } catch {
    return sourceDir.split("/").pop() || "Unknown";
  }
}
