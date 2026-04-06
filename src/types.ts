/**
 * Core types for web-agent's analysis pipeline.
 *
 * The pipeline flows: FileDiscovery → AST Parsing → Extraction → LLM → Output
 */

// ─── File Discovery ─────────────────────────────────────────────────────────

export interface DiscoveredFile {
  path: string;
  relativePath: string;
  content: string;
}

// ─── Route Extraction ────────────────────────────────────────────────────────

export interface Route {
  path: string;
  filePath: string;
  componentName: string;
  isDynamic: boolean;
  /** Nested child routes (Next.js layout nesting) */
  children: Route[];
  /** The layout wrapping this route, if any */
  layoutFile?: string;
}

// ─── Component & Interaction Extraction ──────────────────────────────────────

export interface InteractiveElement {
  type: "button" | "link" | "form" | "input" | "select" | "custom";
  /** Raw text label if extractable (e.g., button text, link text) */
  label?: string;
  /** The event handler name or inline code */
  handler?: string;
  /** Handler type: onClick, onSubmit, etc. */
  handlerType?: string;
  /** Source code of the handler function body */
  handlerBody?: string;
  /** CSS-like selector hint */
  selector?: string;
  /** Form fields if this is a form element */
  formFields?: FormField[];
  /** Navigation target if this is a link */
  href?: string;
}

export interface FormField {
  name: string;
  type: string;
  required: boolean;
  label?: string;
  placeholder?: string;
  validation?: string;
}

export interface ConditionalBranch {
  condition: string;
  elements: string[];
}

export interface ApiCall {
  method: string;
  endpoint: string;
  /** Inferred payload shape */
  payload?: Record<string, string>;
}

export interface ComponentAnalysis {
  filePath: string;
  componentName: string;
  /** Raw source code of the component */
  sourceCode: string;
  interactions: InteractiveElement[];
  conditionals: ConditionalBranch[];
  apiCalls: ApiCall[];
  /** Imported component file paths */
  imports: string[];
}

// ─── LLM-Enriched Output ────────────────────────────────────────────────────

export interface PageDescription {
  path: string;
  description: string;
  preconditions: string[];
  interactions: InteractionDescription[];
  forms: FormDescription[];
  navigation: NavigationDescription[];
  conditionalElements: ConditionalElementDescription[];
}

export interface InteractionDescription {
  element: string;
  label: string;
  description: string;
  action: {
    type: "api_call" | "navigation" | "state_change" | "modal" | "unknown";
    method?: string;
    endpoint?: string;
    payload?: Record<string, string>;
    destination?: string;
    result?: string;
  };
  confidence: "verified" | "inferred" | "unresolved";
  preconditions: string[];
}

export interface FormDescription {
  name: string;
  description: string;
  fields: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    validation?: string;
  }>;
  submitsTo?: string;
}

export interface NavigationDescription {
  element: string;
  label: string;
  destination: string;
  description: string;
}

export interface ConditionalElementDescription {
  element: string;
  description: string;
  condition: string;
  confidence: "verified" | "inferred";
}

// ─── Final browser.txt Schema ────────────────────────────────────────────────

export interface BrowserTxt {
  site: string;
  generated: string;
  generator: string;
  pages: PageDescription[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface CrawlerConfig {
  /** Root directory to analyze */
  sourceDir: string;
  /** Output file path */
  output: string;
  /** OpenAI API key */
  openaiApiKey?: string;
  /** OpenAI model to use */
  model: string;
  /** File patterns to include */
  include: string[];
  /** File patterns to exclude */
  exclude: string[];
  /** Framework detection: "nextjs" | "react-router" | "auto" */
  framework: "nextjs" | "react-router" | "auto";
  /** Skip LLM enrichment */
  skipLlm?: boolean;
}
