#!/usr/bin/env node
import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import { analyze } from "./analyze.js";
import { runAgent } from "./agent.js";
import { evaluateResult, generateReport, printReport, saveReport } from "./eval.js";
import type { EvalTask } from "./eval.js";
import { readFileSync } from "fs";

loadEnv();

const program = new Command();

program
  .name("web-agent")
  .description("Generate browser.txt — a machine-readable site map for AI agents.")
  .version("0.1.0");

// ─── analyze ──────────────────────────────────────────────────────────────────

program
  .command("analyze")
  .description("Analyze a frontend codebase and generate browser.txt")
  .argument("<source>", "Path to the source directory (e.g., ./src or .)")
  .option("-o, --output <path>", "Output file path", "browser.txt")
  .option("-k, --api-key <key>", "OpenAI API key (or set OPENAI_API_KEY env)")
  .option("-m, --model <model>", "OpenAI model to use", "gpt-4o-mini")
  .option("--framework <type>", "Framework: nextjs | react-router | auto", "auto")
  .option("--no-llm", "Skip LLM enrichment, output AST-only analysis")
  .action(async (source: string, opts) => {
    await analyze({
      sourceDir: source,
      output: opts.output,
      openaiApiKey: opts.apiKey || process.env.OPENAI_API_KEY,
      model: opts.model,
      include: ["**/*.tsx", "**/*.jsx", "**/*.ts", "**/*.js"],
      exclude: [
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
      ],
      framework: opts.framework,
      skipLlm: opts.llm === false,
    });
  });

// ─── navigate ─────────────────────────────────────────────────────────────────

program
  .command("navigate")
  .description("Use the browser agent to accomplish a task on a website")
  .argument("<url>", "The URL to start navigating from")
  .argument("<goal>", "What the agent should accomplish (in quotes)")
  .option("-s, --sitemap <path>", "Path to browser.txt site map", "browser.txt")
  .option("-k, --api-key <key>", "OpenAI API key (or set OPENAI_API_KEY env)")
  .option("-m, --model <model>", "OpenAI model to use", "gpt-4o-mini")
  .option("--max-steps <n>", "Maximum steps before giving up", "15")
  .option("--headless", "Run browser in headless mode", true)
  .option("--no-headless", "Run browser visibly (non-headless)")
  .action(async (url: string, goal: string, opts) => {
    const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("Error: OpenAI API key required. Use -k or set OPENAI_API_KEY.");
      process.exit(1);
    }

    const result = await runAgent({
      goal,
      startUrl: url,
      siteMapPath: opts.sitemap,
      maxSteps: parseInt(opts.maxSteps, 10),
      apiKey,
      model: opts.model,
      headless: opts.headless,
    });

    console.log("\n" + "─".repeat(50));
    console.log(`  Result: ${result.success ? "✅ SUCCESS" : "❌ FAILED"}`);
    console.log(`  Steps: ${result.totalSteps}`);
    console.log(`  Duration: ${result.totalDurationMs}ms`);
    console.log(`  Final URL: ${result.finalUrl}`);
    if (result.error) console.log(`  Error: ${result.error}`);
    console.log("─".repeat(50) + "\n");

    process.exit(result.success ? 0 : 1);
  });

// ─── eval ─────────────────────────────────────────────────────────────────────

program
  .command("eval")
  .description("Run eval tasks against the browser agent and report metrics")
  .argument("<tasks-file>", "Path to JSON file with eval tasks")
  .option("-s, --sitemap <path>", "Path to browser.txt site map", "browser.txt")
  .option("-k, --api-key <key>", "OpenAI API key (or set OPENAI_API_KEY env)")
  .option("-m, --model <model>", "OpenAI model to use", "gpt-4o-mini")
  .option("--max-steps <n>", "Maximum steps per task", "15")
  .option("-o, --output <path>", "Save report to file")
  .option("--headless", "Run browser in headless mode", true)
  .option("--no-headless", "Run browser visibly (non-headless)")
  .action(async (tasksFile: string, opts) => {
    const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("Error: OpenAI API key required. Use -k or set OPENAI_API_KEY.");
      process.exit(1);
    }

    const tasks = JSON.parse(readFileSync(tasksFile, "utf-8")) as EvalTask[];
    console.log(`\n📋 Running ${tasks.length} eval tasks...\n`);

    const results = [];
    for (const task of tasks) {
      console.log(`\n🔄 Task: ${task.name}`);
      console.log(`   Goal: ${task.goal}\n`);

      const agentResult = await runAgent({
        goal: task.goal,
        startUrl: task.startUrl,
        siteMapPath: opts.sitemap,
        maxSteps: parseInt(opts.maxSteps, 10),
        apiKey,
        model: opts.model,
        headless: opts.headless,
      });

      results.push(evaluateResult(task, agentResult));
    }

    const report = generateReport(results, opts.sitemap);
    printReport(report);

    if (opts.output) {
      saveReport(report, opts.output);
      console.log(`📄 Report saved to ${opts.output}`);
    }
  });

program.parse();
