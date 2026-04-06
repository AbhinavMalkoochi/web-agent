import { writeFileSync } from "fs";
import type { BrowserTxt, PageDescription } from "./types.js";

/**
 * Compile analyzed pages into the browser.txt JSON output.
 */
export function compileBrowserTxt(
  pages: PageDescription[],
  siteName: string
): BrowserTxt {
  return {
    site: siteName,
    generated: new Date().toISOString(),
    generator: "web-agent v0.1.0",
    pages: pages.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/**
 * Write browser.txt to disk.
 */
export function writeBrowserTxt(data: BrowserTxt, outputPath: string): void {
  writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Produce a human-readable summary of the analysis for the terminal.
 */
export function summarize(data: BrowserTxt): string {
  const lines: string[] = [];
  lines.push(`\n📄 browser.txt generated for "${data.site}"`);
  lines.push(`   ${data.pages.length} pages analyzed\n`);

  let totalInteractions = 0;
  let verified = 0;
  let inferred = 0;

  for (const page of data.pages) {
    const count = page.interactions.length;
    totalInteractions += count;
    for (const i of page.interactions) {
      if (i.confidence === "verified") verified++;
      else inferred++;
    }
    lines.push(`   ${page.path} — ${count} interactions, ${page.forms.length} forms, ${page.navigation.length} nav links`);
  }

  lines.push("");
  lines.push(
    `   Total: ${totalInteractions} interactions (${verified} verified, ${inferred} inferred)`
  );
  lines.push(`   Conditional elements: ${data.pages.reduce((s, p) => s + p.conditionalElements.length, 0)}`);
  lines.push("");

  return lines.join("\n");
}
