import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { AgentResult } from "./agent.js";

export interface EvalTask {
  name: string;
  goal: string;
  startUrl: string;
  /** How to verify the task was completed */
  successCriteria: {
    /** URL pattern the agent should end up on */
    finalUrlContains?: string;
    /** Minimum number of steps expected */
    minSteps?: number;
    /** Maximum number of steps expected */
    maxSteps?: number;
    /** Maximum time allowed in ms */
    maxDurationMs?: number;
  };
}

export interface EvalReport {
  timestamp: string;
  siteMapPath: string;
  tasks: EvalTaskResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    avgDurationMs: number;
    avgSteps: number;
  };
}

export interface EvalTaskResult {
  task: EvalTask;
  agentResult: AgentResult;
  passed: boolean;
  failures: string[];
}

/**
 * Evaluate an agent result against success criteria.
 */
export function evaluateResult(task: EvalTask, result: AgentResult): EvalTaskResult {
  const failures: string[] = [];

  if (!result.success) {
    failures.push(`Agent did not report success: ${result.error || "unknown reason"}`);
  }

  const criteria = task.successCriteria;

  if (criteria.finalUrlContains && !result.finalUrl.includes(criteria.finalUrlContains)) {
    failures.push(
      `Expected final URL to contain "${criteria.finalUrlContains}", got "${result.finalUrl}"`
    );
  }

  if (criteria.maxSteps && result.totalSteps > criteria.maxSteps) {
    failures.push(
      `Took ${result.totalSteps} steps, max allowed: ${criteria.maxSteps}`
    );
  }

  if (criteria.minSteps && result.totalSteps < criteria.minSteps) {
    failures.push(
      `Took ${result.totalSteps} steps, min expected: ${criteria.minSteps}`
    );
  }

  if (criteria.maxDurationMs && result.totalDurationMs > criteria.maxDurationMs) {
    failures.push(
      `Took ${result.totalDurationMs}ms, max allowed: ${criteria.maxDurationMs}ms`
    );
  }

  return {
    task,
    agentResult: result,
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Generate and print an eval report.
 */
export function generateReport(
  results: EvalTaskResult[],
  siteMapPath: string
): EvalReport {
  const durations = results.map((r) => r.agentResult.totalDurationMs);
  const stepCounts = results.map((r) => r.agentResult.totalSteps);

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    siteMapPath,
    tasks: results,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      avgDurationMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      avgSteps: Math.round((stepCounts.reduce((a, b) => a + b, 0) / stepCounts.length) * 10) / 10,
    },
  };

  return report;
}

/**
 * Print eval report to console.
 */
export function printReport(report: EvalReport): void {
  console.log("\n" + "═".repeat(60));
  console.log("  EVAL REPORT");
  console.log("═".repeat(60));
  console.log(`  Time: ${report.timestamp}`);
  console.log(`  Site Map: ${report.siteMapPath}`);
  console.log("");

  for (const result of report.tasks) {
    const icon = result.passed ? "✅" : "❌";
    console.log(`  ${icon} ${result.task.name}`);
    console.log(`     Goal: ${result.task.goal}`);
    console.log(`     Steps: ${result.agentResult.totalSteps} | Duration: ${result.agentResult.totalDurationMs}ms`);
    console.log(`     Final URL: ${result.agentResult.finalUrl}`);

    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        console.log(`     ⚠️  ${failure}`);
      }
    }

    // Print step details
    for (const step of result.agentResult.steps) {
      const stepIcon = step.success ? "→" : "✗";
      console.log(`     ${stepIcon} Step ${step.step}: ${step.action} ${step.selector || step.url || ""} (${step.durationMs}ms)`);
      console.log(`       ${step.reasoning}`);
    }
    console.log("");
  }

  console.log("─".repeat(60));
  console.log(`  Total: ${report.summary.total} | Passed: ${report.summary.passed} | Failed: ${report.summary.failed}`);
  console.log(`  Avg Duration: ${report.summary.avgDurationMs}ms | Avg Steps: ${report.summary.avgSteps}`);
  console.log("═".repeat(60) + "\n");
}

export function saveReport(report: EvalReport, outputPath: string): void {
  writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");
}
