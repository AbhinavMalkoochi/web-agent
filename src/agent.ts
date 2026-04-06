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

      // Detect loops: consecutive repeats OR ping-pong patterns
      const loopDetected = detectLoop(steps);
      if (loopDetected) {
        console.log(`   ⚠️  ${loopDetected}`);
        steps.push({
          step: stepNum,
          action: "DONE",
          reasoning: loopDetected,
          timestamp: Date.now(),
          durationMs: 0,
          success: true,
        });
        return {
          task: task.goal,
          success: false,
          steps,
          totalDurationMs: Date.now() - startTime,
          totalSteps: steps.length,
          finalUrl: page.url(),
          error: loopDetected,
        };
      }

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
          // Construct full URL if only a path is given
          let targetUrl = decision.url || task.startUrl;
          if (targetUrl.startsWith("/")) {
            const base = new URL(task.startUrl);
            targetUrl = `${base.origin}${targetUrl}`;
          }
          await page.goto(targetUrl, {
            waitUntil: "networkidle",
            timeout: 15000,
          });
          // Detect auth redirects: if we ended up on a different page
          const finalUrl = page.url();
          const targetPath = new URL(targetUrl).pathname.replace(/\/$/, "") || "/";
          const finalPath = new URL(finalUrl).pathname.replace(/\/$/, "") || "/";
          if (finalPath !== targetPath) {
            step.success = false;
            step.reasoning += ` → REDIRECTED to ${finalPath} (likely auth required)`;
          } else {
            step.success = true;
          }
        } else if (decision.action === "click") {
          const urlBefore = page.url();
          await smartClick(page, decision.selector || "", decision.label || "");
          // If the click triggered a navigation, wait for it
          const urlAfter = page.url();
          if (urlAfter !== urlBefore) {
            await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          } else {
            await page.waitForTimeout(800);
          }
          step.success = true;
        } else if (decision.action === "fill") {
          await page.fill(decision.selector || "", decision.value || "", { timeout: 5000 });
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
  "url": "full URL or just path like /dashboard (for navigate)",
  "value": "text to type (for fill)",
  "reasoning": "brief explanation of why this action moves toward the goal"
}

CRITICAL RULES:
1. NAVIGATE FIRST: Use "navigate" with a path from the site map (e.g. "/dashboard/donations") to go directly to any page. This is faster and more reliable than clicking links.
2. DONE EARLY: Once you have reached the page that matches the goal, return "DONE" IMMEDIATELY. Do NOT keep interacting after reaching the target. If the goal says "navigate to X" and you are now on X, you are DONE.
3. NO REPETITION: NEVER repeat the same action more than once. If an action failed or didn't change the page, try a completely different approach or return "DONE".
4. AUTH DETECTION: If you see a REDIRECTED message in previous steps AND the final URL is a login/auth page (e.g. /login, /sign-in, /auth), it means authentication is required. Return "DONE" immediately. Trailing slash redirects (e.g. /pricing → /pricing/) are NOT auth redirects.
5. ONE-SHOT NAVIGATION: If the goal is to navigate somewhere and the site map has the path, use a single "navigate" action, then "DONE". Do not click buttons or fill forms for pure navigation tasks.
6. STAY PUT: After navigating to the target page, do NOT click any links or buttons that would take you away from it.
7. Prefer clicking by text content (button text, link text) over CSS selectors: 'text=Button Text' or 'button:has-text("Submit")'.
8. Be decisive: each step should make concrete progress toward the goal.`;

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

// ─── Loop Detection ──────────────────────────────────────────────────────────

function stepKey(s: AgentStep): string {
  return `${s.action}::${s.selector || s.url || ""}`;
}

function detectLoop(steps: AgentStep[]): string | null {
  if (steps.length < 2) return null;

  // Pattern 1: Same action repeated 3+ times (A-A-A)
  const last = steps[steps.length - 1];
  const lastKey = stepKey(last);
  let repeatCount = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (stepKey(steps[i]) === lastKey) repeatCount++;
    else break;
  }
  if (repeatCount >= 2) return `Loop detected: same action repeated ${repeatCount + 1} times. Forcing DONE.`;

  // Pattern 2: Ping-pong (A-B-A-B) — check last 4 steps
  if (steps.length >= 4) {
    const s = steps.slice(-4);
    if (stepKey(s[0]) === stepKey(s[2]) && stepKey(s[1]) === stepKey(s[3]) && stepKey(s[0]) !== stepKey(s[1])) {
      return `Loop detected: ping-pong pattern (alternating actions). Forcing DONE.`;
    }
  }

  // Pattern 3: URL oscillation — visited same URL 3+ times
  if (steps.length >= 4) {
    const urlSteps = steps.filter((s) => s.url);
    if (urlSteps.length >= 3) {
      const lastUrl = urlSteps[urlSteps.length - 1].url;
      const visits = urlSteps.filter((s) => s.url === lastUrl).length;
      if (visits >= 3) return `Loop detected: same URL visited ${visits} times. Forcing DONE.`;
    }
  }

  return null;
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
    if (await el.isVisible({ timeout: 2000 })) {
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
      if (await textEl.isVisible({ timeout: 2000 })) {
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
      if (await roleEl.isVisible({ timeout: 2000 })) {
        await roleEl.click();
        return;
      }
    } catch {
      // Fall through
    }

    try {
      const linkEl = page.getByRole("link", { name: label }).first();
      if (await linkEl.isVisible({ timeout: 2000 })) {
        await linkEl.click();
        return;
      }
    } catch {
      // Fall through
    }
  }

  // Last resort: try the raw selector
  await page.click(selector, { timeout: 3000 });
}
