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
  //    Also includes the layout file's tree if present (sidebar navigation, etc.)
  const analyses = routes.map((route) => {
    const file = files.find((f) => f.path === route.filePath);
    if (!file) return null;
    console.log(`   Analyzing ${route.path}...`);
    const pageAnalysis = analyzeComponentTree(file, files, sourceDir);

    // Also analyze the layout file if it exists (contains shared navigation)
    if (route.layoutFile) {
      const layoutFile = files.find((f) => f.path === route.layoutFile);
      if (layoutFile) {
        const layoutAnalysis = analyzeComponentTree(layoutFile, files, sourceDir);
        // Merge layout interactions into the page analysis
        pageAnalysis.interactions.push(...layoutAnalysis.interactions);
        pageAnalysis.apiCalls.push(...layoutAnalysis.apiCalls);
        pageAnalysis.conditionals.push(...layoutAnalysis.conditionals);
        pageAnalysis.imports.push(...layoutAnalysis.imports);
        // Append layout source for LLM context
        pageAnalysis.sourceCode += "\n\n// === LAYOUT ===\n" + layoutAnalysis.sourceCode;
      }
    }

    return { route, analysis: pageAnalysis };
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

    // Run LLM calls in parallel with concurrency limit of 5
    const CONCURRENCY = 5;
    const pending = analyses.map(({ route, analysis }) => ({
      route,
      analysis,
      started: false,
    }));

    const results: Array<{ route: typeof routes[0]; page: PageDescription }> = [];

    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const batch = pending.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async ({ route, analysis }) => {
          const page = await describeRoute(route, analysis, config.openaiApiKey!, config.model);
          console.log(`   Describing ${route.path}... ✓ (${page.interactions.length} interactions)`);
          return { route, page };
        })
      );
      results.push(...batchResults);
    }

    // Sort results back to original order
    for (const { page } of results) {
      pages.push(page);
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
