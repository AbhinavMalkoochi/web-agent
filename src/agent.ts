import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import OpenAI from "openai";
import { readFileSync } from "fs";
import type { BrowserTxt, PageDescription } from "./types.js";

export interface AgentTask {
  goal: string;
  startUrl: string;
  siteMapPath: string;
  maxSteps: number;
  apiKey: string;
  model: string;
  headless: boolean;
}

export interface AgentStep {
  step: number;
  action: string;
  selector?: string;
  url?: string;
  reasoning: string;
  timestamp: number;
  durationMs: number;
  success: boolean;
  screenshot?: string;
}

export interface AgentResult {
  task: string;
  success: boolean;
  steps: AgentStep[];
  totalDurationMs: number;
  totalSteps: number;
  finalUrl: string;
  error?: string;
}

/**
 * The browser agent reads browser.txt to understand a website's structure,
 * then uses Playwright to navigate it deterministically, guided by LLM reasoning.
 *
 * Unlike traditional browser agents that "see" the page and guess,
 * this agent has a complete, pre-computed map of every interaction.
 */
export async function runAgent(task: AgentTask): Promise<AgentResult> {
  const startTime = Date.now();
  const steps: AgentStep[] = [];
  let browser: Browser | null = null;

  try {
    // 1. Load the site map
    const siteMap = JSON.parse(readFileSync(task.siteMapPath, "utf-8")) as BrowserTxt;
    console.log(`\n🗺️  Loaded site map: ${siteMap.pages.length} pages\n`);

    // 2. Launch browser
    browser = await chromium.launch({ headless: task.headless });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    // 3. Navigate to start URL
    console.log(`🌐 Navigating to ${task.startUrl}...\n`);
    await page.goto(task.startUrl, { waitUntil: "networkidle", timeout: 30000 });

    const openai = new OpenAI({ apiKey: task.apiKey });

    // 4. Agent loop: plan and execute steps
    for (let stepNum = 1; stepNum <= task.maxSteps; stepNum++) {
      const stepStart = Date.now();
      const currentUrl = page.url();
      const currentPath = new URL(currentUrl).pathname;

      // Get the page description from the site map
      const pageInfo = findPageInSiteMap(currentPath, siteMap);
      const pageContent = await getPageText(page);

      // Ask the LLM what to do next
      const decision = await planNextStep(openai, task.model, {
        goal: task.goal,
        currentUrl,
        currentPath,
        pageInfo,
        pageContent,
        previousSteps: steps,
        siteMap,
      });

      console.log(`   Step ${stepNum}: ${decision.action} — ${decision.reasoning}`);

      const step: AgentStep = {
        step: stepNum,
        action: decision.action,
        selector: decision.selector,
        url: decision.url,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
        durationMs: 0,
        success: false,
      };

      try {
        // Execute the action
        if (decision.action === "DONE") {
          step.success = true;
          step.durationMs = Date.now() - stepStart;
          steps.push(step);
          console.log(`\n✅ Agent reports task complete.\n`);
          return {
            task: task.goal,
            success: true,
            steps,
            totalDurationMs: Date.now() - startTime,
            totalSteps: steps.length,
            finalUrl: page.url(),
          };
        }

        if (decision.action === "navigate") {
          await page.goto(decision.url || task.startUrl, {
            waitUntil: "networkidle",
            timeout: 15000,
          });
          step.success = true;
        } else if (decision.action === "click") {
          await smartClick(page, decision.selector || "", decision.label || "");
          await page.waitForTimeout(1000);
          step.success = true;
        } else if (decision.action === "fill") {
          await page.fill(decision.selector || "", decision.value || "");
          step.success = true;
        } else if (decision.action === "wait") {
          await page.waitForTimeout(2000);
          step.success = true;
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        step.success = false;
        console.log(`   ⚠️  Action failed: ${errorMsg}`);
      }

      step.durationMs = Date.now() - stepStart;
      steps.push(step);
    }

    console.log(`\n⚠️  Max steps (${task.maxSteps}) reached.\n`);
    return {
      task: task.goal,
      success: false,
      steps,
      totalDurationMs: Date.now() - startTime,
      totalSteps: steps.length,
      finalUrl: page.url(),
      error: "Max steps reached without completing the task.",
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      task: task.goal,
      success: false,
      steps,
      totalDurationMs: Date.now() - startTime,
      totalSteps: steps.length,
      finalUrl: "",
      error: errorMsg,
    };
  } finally {
    if (browser) await browser.close();
  }
}

// ─── LLM Planning ────────────────────────────────────────────────────────────

interface PlanContext {
  goal: string;
  currentUrl: string;
  currentPath: string;
  pageInfo: PageDescription | null;
  pageContent: string;
  previousSteps: AgentStep[];
  siteMap: BrowserTxt;
}

interface StepDecision {
  action: "navigate" | "click" | "fill" | "wait" | "DONE";
  selector?: string;
  label?: string;
  url?: string;
  value?: string;
  reasoning: string;
}

const AGENT_SYSTEM_PROMPT = `You are a browser automation agent. You navigate websites to accomplish tasks.

You have a COMPLETE site map (browser.txt) that describes every page, interaction, form, and navigation element on the site. Use this map to plan your actions precisely — do NOT guess or explore blindly.

For each step, respond with a JSON object:
{
  "action": "navigate" | "click" | "fill" | "wait" | "DONE",
  "selector": "CSS selector or text content to target (for click/fill)",
  "label": "human-readable label of the element (for click)",
  "url": "full URL (for navigate)",
  "value": "text to type (for fill)",
  "reasoning": "brief explanation of why this action moves toward the goal"
}

Rules:
- Use the site map to identify which page has the elements you need.
- Navigate to the correct page FIRST, then interact with elements on it.
- Prefer clicking by text content (button text, link text) over CSS selectors.
- For "click", provide a selector like 'text=Button Text' or 'button:has-text("Submit")'.
- Return "DONE" when the goal is achieved or you've confirmed the task is complete.
- If stuck, try a different approach rather than repeating failed actions.
- Be decisive: each step should make concrete progress toward the goal.`;

async function planNextStep(
  openai: OpenAI,
  model: string,
  ctx: PlanContext
): Promise<StepDecision> {
  // Build available pages summary
  const pagesSummary = ctx.siteMap.pages
    .map((p) => `  ${p.path}: ${p.description}`)
    .join("\n");

  // Build current page info
  let currentPageInfo = "No site map entry for this page.";
  if (ctx.pageInfo) {
    currentPageInfo = JSON.stringify(ctx.pageInfo, null, 2);
  }

  // Build step history
  const history = ctx.previousSteps
    .map((s) => `  Step ${s.step}: ${s.action} ${s.selector || s.url || ""} — ${s.reasoning} (${s.success ? "OK" : "FAILED"})`)
    .join("\n");

  const prompt = `GOAL: ${ctx.goal}

CURRENT URL: ${ctx.currentUrl}
CURRENT PATH: ${ctx.currentPath}

SITE MAP — ALL PAGES:
${pagesSummary}

CURRENT PAGE DETAILS:
${currentPageInfo}

VISIBLE PAGE TEXT (first 2000 chars):
${ctx.pageContent.slice(0, 2000)}

PREVIOUS STEPS:
${history || "  (none)"}

What is the next action to achieve the goal? Respond with a single JSON object.`;

  const response = await openai.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  });

  const raw = response.choices[0]?.message?.content || "{}";
  try {
    return JSON.parse(raw) as StepDecision;
  } catch {
    return { action: "DONE", reasoning: "Failed to parse LLM response" };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findPageInSiteMap(path: string, siteMap: BrowserTxt): PageDescription | null {
  // Exact match first
  const exact = siteMap.pages.find((p) => p.path === path);
  if (exact) return exact;

  // Try matching dynamic routes: /[slug] → /anything
  for (const page of siteMap.pages) {
    if (!page.path.includes("[")) continue;
    const pattern = page.path.replace(/\[([^\]]+)\]/g, "[^/]+");
    const regex = new RegExp(`^${pattern}$`);
    if (regex.test(path)) return page;
  }

  return null;
}

async function getPageText(page: Page): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    return await page.evaluate("document.body?.innerText || ''") as string;
  } catch {
    return "";
  }
}

async function smartClick(page: Page, selector: string, label: string): Promise<void> {
  // Try the selector first
  try {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout: 3000 })) {
      await el.click();
      return;
    }
  } catch {
    // Fall through
  }

  // Try by text
  if (label) {
    try {
      const textEl = page.getByText(label, { exact: false }).first();
      if (await textEl.isVisible({ timeout: 3000 })) {
        await textEl.click();
        return;
      }
    } catch {
      // Fall through
    }
  }

  // Try by role
  if (label) {
    try {
      const roleEl = page.getByRole("button", { name: label }).first();
      if (await roleEl.isVisible({ timeout: 3000 })) {
        await roleEl.click();
        return;
      }
    } catch {
      // Fall through
    }

    try {
      const linkEl = page.getByRole("link", { name: label }).first();
      if (await linkEl.isVisible({ timeout: 3000 })) {
        await linkEl.click();
        return;
      }
    } catch {
      // Fall through
    }
  }

  // Last resort: try the raw selector
  await page.click(selector, { timeout: 5000 });
}
