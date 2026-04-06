#!/usr/bin/env node
import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import { analyze } from "./analyze.js";

loadEnv();

const program = new Command();

program
  .name("web-agent")
  .description("Generate browser.txt — a machine-readable site map for AI agents.")
  .version("0.1.0");

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

program.parse();
