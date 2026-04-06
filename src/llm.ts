import OpenAI from "openai";
import type { ComponentAnalysis, Route, PageDescription } from "./types.js";

let client: OpenAI | null = null;

function getClient(apiKey: string): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey });
  }
  return client;
}

/**
 * Given a route and its component analysis, ask the LLM to produce a
 * complete PageDescription with semantic descriptions for every
 * interaction, form, navigation element, and conditional.
 */
export async function describeRoute(
  route: Route,
  analysis: ComponentAnalysis,
  apiKey: string,
  model: string
): Promise<PageDescription> {
  const openai = getClient(apiKey);

  const prompt = buildPrompt(route, analysis);

  try {
    const response = await openai.chat.completions.create({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }, { timeout: 60000 });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return fallbackDescription(route, analysis);
    }

    const parsed = JSON.parse(content) as PageDescription;
    return {
      ...parsed,
      path: route.path,
    };
  } catch {
    return fallbackDescription(route, analysis);
  }
}

const SYSTEM_PROMPT = `You are analyzing a web application to produce a machine-readable interaction map (browser.txt).

Your job: Given a route and its component source code with AST-extracted structural data, produce a JSON object describing the page and ALL its interactions in natural language that an AI agent can use to navigate the site.

The output JSON must match this exact schema:
{
  "path": "/route-path",
  "description": "One sentence describing what this page does from the user's perspective.",
  "preconditions": ["List of conditions required to access this page, e.g. 'User must be logged in'"],
  "interactions": [
    {
      "element": "css-selector-hint",
      "label": "Button/Link text",
      "description": "What happens when this element is clicked/submitted, written for an AI agent.",
      "action": {
        "type": "api_call | navigation | state_change | modal | unknown",
        "method": "GET/POST/PUT/DELETE (if api_call)",
        "endpoint": "/api/endpoint (if api_call)",
        "destination": "/target-route (if navigation)",
        "result": "What happens after the action completes"
      },
      "confidence": "verified | inferred",
      "preconditions": ["Any conditions for this element to be visible/enabled"]
    }
  ],
  "forms": [
    {
      "name": "form-identifier",
      "description": "What this form collects and does.",
      "fields": [
        { "name": "fieldName", "type": "text|email|password|etc", "required": true, "description": "What this field is for", "validation": "any validation rules" }
      ],
      "submitsTo": "element reference or endpoint"
    }
  ],
  "navigation": [
    {
      "element": "link-selector",
      "label": "Link text",
      "destination": "/target-route",
      "description": "Where this link goes and why a user would click it."
    }
  ],
  "conditionalElements": [
    {
      "element": "element-description",
      "description": "What this element does",
      "condition": "When this element appears (in user-facing terms)",
      "confidence": "verified | inferred"
    }
  ]
}

Guidelines:
- Write descriptions from the perspective of what an AI agent needs to know to USE the site, not to understand the code.
- Be concise but complete. Every interactive element must be described.
- If the code uses server actions (Next.js "use server"), the action IS the API endpoint.
- For Convex mutations/queries, describe them as API calls with the function path as the endpoint.
- Infer preconditions from conditional rendering, auth checks, and route guards.
- Set confidence to "verified" when you can clearly see the API call or destination. Set to "inferred" when you're interpreting behavior from naming/context.`;

function buildPrompt(route: Route, analysis: ComponentAnalysis): string {
  const parts: string[] = [];

  parts.push(`## Route: ${route.path}`);
  parts.push(`## Component: ${analysis.componentName} (${analysis.filePath})`);
  parts.push("");

  // Source code (truncated if too long)
  const source =
    analysis.sourceCode.length > 8000
      ? analysis.sourceCode.slice(0, 8000) + "\n... (truncated)"
      : analysis.sourceCode;
  parts.push("## Source Code:");
  parts.push("```tsx");
  parts.push(source);
  parts.push("```");
  parts.push("");

  // AST-extracted structure
  if (analysis.interactions.length > 0) {
    parts.push("## AST-Extracted Interactive Elements:");
    for (const el of analysis.interactions) {
      parts.push(
        `- ${el.type}: ${el.label || "(no label)"} | handler: ${el.handlerType || "none"}=${el.handler || "none"} | selector: ${el.selector || "?"}`
      );
      if (el.formFields && el.formFields.length > 0) {
        for (const field of el.formFields) {
          parts.push(
            `  - field: ${field.name} (${field.type}) ${field.required ? "required" : ""}`
          );
        }
      }
      if (el.href) {
        parts.push(`  - href: ${el.href}`);
      }
    }
    parts.push("");
  }

  if (analysis.apiCalls.length > 0) {
    parts.push("## AST-Detected API Calls:");
    for (const api of analysis.apiCalls) {
      parts.push(`- ${api.method} ${api.endpoint}`);
    }
    parts.push("");
  }

  if (analysis.conditionals.length > 0) {
    parts.push("## Conditional Rendering:");
    for (const cond of analysis.conditionals) {
      parts.push(`- When \`${cond.condition}\`: shows ${cond.elements.join(", ")}`);
    }
    parts.push("");
  }

  if (analysis.imports.length > 0) {
    parts.push("## Local Imports:");
    parts.push(analysis.imports.map((i) => `- ${i}`).join("\n"));
  }

  return parts.join("\n");
}

export function fallbackDescription(route: Route, analysis: ComponentAnalysis): PageDescription {
  return {
    path: route.path,
    description: `Page at ${route.path} (${analysis.componentName})`,
    preconditions: [],
    interactions: analysis.interactions.map((el) => ({
      element: el.selector || el.type,
      label: el.label || el.type,
      description: `${el.type} element${el.handler ? ` triggers ${el.handler}` : ""}`,
      action: {
        type: el.href ? "navigation" as const : "unknown" as const,
        destination: el.href,
      },
      confidence: "inferred" as const,
      preconditions: [],
    })),
    forms: [],
    navigation: analysis.interactions
      .filter((el) => el.type === "link" && el.href)
      .map((el) => ({
        element: el.selector || "link",
        label: el.label || "Link",
        destination: el.href || "/",
        description: `Navigate to ${el.href}`,
      })),
    conditionalElements: analysis.conditionals.map((cond) => ({
      element: cond.elements.join(", "),
      description: `Rendered when ${cond.condition}`,
      condition: cond.condition,
      confidence: "inferred" as const,
    })),
  };
}
