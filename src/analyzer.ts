import * as _traverseModule from "@babel/traverse";
import type { Node } from "@babel/types";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { parseSource } from "./parser.js";
import type {
  ComponentAnalysis,
  InteractiveElement,
  ConditionalBranch,
  ApiCall,
  FormField,
} from "./types.js";

// Handle CJS/ESM interop for @babel/traverse
const traverse = (
  (_traverseModule as Record<string, unknown>).default as Record<string, unknown>
).default as (parent: Node, opts: Record<string, unknown>) => void;

const EVENT_HANDLERS = new Set([
  "onClick",
  "onSubmit",
  "onChange",
  "onBlur",
  "onFocus",
  "onKeyDown",
  "onKeyUp",
  "onMouseDown",
  "onDoubleClick",
]);

const API_PATTERNS = ["fetch", "axios", "api", "mutation", "useMutation"];

/**
 * Analyze a single component file: extract interactive elements, forms,
 * conditionals, and API call patterns.
 */
export function analyzeComponent(
  filePath: string,
  sourceCode: string
): ComponentAnalysis {
  const ast = parseSource(sourceCode, filePath);
  const interactions: InteractiveElement[] = [];
  const conditionals: ConditionalBranch[] = [];
  const apiCalls: ApiCall[] = [];
  const imports: string[] = [];
  let componentName = "Unknown";

  traverse(ast, {
    // Capture the component name from default export or named function
    ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id) {
        componentName = decl.id.name;
      } else if (t.isIdentifier(decl)) {
        componentName = decl.name;
      }
    },

    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      if (path.node.id && /^[A-Z]/.test(path.node.id.name)) {
        componentName = path.node.id.name;
      }
    },

    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (t.isIdentifier(path.node.id) && /^[A-Z]/.test(path.node.id.name)) {
        componentName = path.node.id.name;
      }
    },

    // Extract import paths for dependency tracking
    ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
      const source = path.node.source.value;
      if (source.startsWith(".") || source.startsWith("@/")) {
        imports.push(source);
      }
    },

    // Find interactive JSX elements
    JSXOpeningElement(path: NodePath<t.JSXOpeningElement>) {
      const element = path.node;
      const name = getJSXElementName(element.name);
      if (!name) return;

      const attrs = element.attributes.filter(
        (a): a is t.JSXAttribute => t.isJSXAttribute(a)
      );

      // Check for event handlers
      for (const attr of attrs) {
        const attrName = t.isJSXIdentifier(attr.name) ? attr.name.name : null;
        if (!attrName || !EVENT_HANDLERS.has(attrName)) continue;

        const interaction: InteractiveElement = {
          type: classifyElement(name),
          handlerType: attrName,
          handler: extractHandlerName(attr.value),
          handlerBody: extractHandlerBody(attr.value, path),
          label: extractTextContent(path),
          selector: buildSelector(name, attrs),
        };
        interactions.push(interaction);
      }

      // Check for links (Next.js Link or <a>)
      if (name === "Link" || name === "a") {
        const href = getAttrValue(attrs, "href") || getAttrValue(attrs, "to");
        if (href) {
          interactions.push({
            type: "link",
            label: extractTextContent(path),
            href,
            selector: buildSelector(name, attrs),
          });
        }
      }

      // Check for form elements
      if (name === "form" || name === "Form") {
        const fields = extractFormFields(path);
        interactions.push({
          type: "form",
          label: extractTextContent(path),
          formFields: fields,
          handlerType: "onSubmit",
          handler: extractHandlerName(
            attrs.find(
              (a) => t.isJSXIdentifier(a.name) && a.name.name === "onSubmit"
            )?.value ?? null
          ),
          selector: buildSelector(name, attrs),
        });
      }

      // Check for input elements
      if (["input", "Input", "select", "Select", "textarea", "Textarea"].includes(name)) {
        const nameAttr = getAttrValue(attrs, "name");
        const typeAttr = getAttrValue(attrs, "type") || "text";
        if (nameAttr) {
          interactions.push({
            type: "input",
            label: getAttrValue(attrs, "placeholder") || nameAttr,
            selector: buildSelector(name, attrs),
            formFields: [
              {
                name: nameAttr,
                type: typeAttr,
                required: attrs.some(
                  (a) => t.isJSXIdentifier(a.name) && a.name.name === "required"
                ),
                placeholder: getAttrValue(attrs, "placeholder"),
              },
            ],
          });
        }
      }
    },

    // Detect conditional rendering: {condition && <Element />}
    LogicalExpression(path: NodePath<t.LogicalExpression>) {
      if (path.node.operator !== "&&") return;
      if (!isInsideJSX(path)) return;

      const condition = extractConditionText(path.node.left, sourceCode);
      const elements = extractJSXNames(path.node.right);
      if (condition && elements.length > 0) {
        conditionals.push({ condition, elements });
      }
    },

    // Detect ternary conditional rendering: {cond ? <A /> : <B />}
    ConditionalExpression(path: NodePath<t.ConditionalExpression>) {
      if (!isInsideJSX(path)) return;

      const condition = extractConditionText(path.node.test, sourceCode);
      const consequent = extractJSXNames(path.node.consequent);
      const alternate = extractJSXNames(path.node.alternate);
      if (condition) {
        if (consequent.length > 0) {
          conditionals.push({ condition, elements: consequent });
        }
        if (alternate.length > 0) {
          conditionals.push({
            condition: `NOT (${condition})`,
            elements: alternate,
          });
        }
      }
    },

    // Detect API calls: fetch(), axios.*, server actions
    CallExpression(path: NodePath<t.CallExpression>) {
      const call = path.node;
      const apiCall = detectApiCall(call, sourceCode);
      if (apiCall) apiCalls.push(apiCall);
    },
  });

  return {
    filePath,
    componentName,
    sourceCode,
    interactions,
    conditionals,
    apiCalls,
    imports,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getJSXElementName(
  name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName
): string | null {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name)) {
    const obj = t.isJSXIdentifier(name.object) ? name.object.name : "";
    return `${obj}.${name.property.name}`;
  }
  return null;
}

function classifyElement(name: string): InteractiveElement["type"] {
  const lower = name.toLowerCase();
  if (lower.includes("button") || lower === "btn") return "button";
  if (lower === "a" || lower === "link") return "link";
  if (lower === "form") return "form";
  if (["input", "select", "textarea"].includes(lower)) return "input";
  return "custom";
}

function extractHandlerName(value: t.JSXAttribute["value"] | null): string | undefined {
  if (!value) return undefined;
  if (t.isJSXExpressionContainer(value)) {
    const expr = value.expression;
    if (t.isIdentifier(expr)) return expr.name;
    if (t.isMemberExpression(expr) && t.isIdentifier(expr.property)) {
      return expr.property.name;
    }
    if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) {
      return "(inline)";
    }
  }
  return undefined;
}

function extractHandlerBody(
  value: t.JSXAttribute["value"] | null,
  _path: any
): string | undefined {
  if (!value) return undefined;
  if (t.isJSXExpressionContainer(value)) {
    const expr = value.expression;
    if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) {
      // Return the raw source range if available
      if (expr.start != null && expr.end != null) {
        return `[inline:${expr.start}-${expr.end}]`;
      }
    }
  }
  return undefined;
}

function extractTextContent(path: any): string | undefined {
  const parent = path.parentPath;
  if (!parent || !t.isJSXElement(parent.node)) return undefined;

  const texts: string[] = [];
  for (const child of parent.node.children) {
    if (t.isJSXText(child)) {
      const trimmed = child.value.trim();
      if (trimmed) texts.push(trimmed);
    }
    if (t.isJSXExpressionContainer(child) && t.isStringLiteral(child.expression)) {
      texts.push(child.expression.value);
    }
  }
  return texts.length > 0 ? texts.join(" ") : undefined;
}

function buildSelector(name: string, attrs: t.JSXAttribute[]): string {
  const id = getAttrValue(attrs, "id");
  const className = getAttrValue(attrs, "className") || getAttrValue(attrs, "class");
  const testId = getAttrValue(attrs, "data-testid");

  if (testId) return `[data-testid="${testId}"]`;
  if (id) return `${name.toLowerCase()}#${id}`;
  if (className) return `${name.toLowerCase()}.${className.split(" ")[0]}`;
  return name.toLowerCase();
}

function getAttrValue(attrs: t.JSXAttribute[], name: string): string | undefined {
  const attr = attrs.find(
    (a) => t.isJSXIdentifier(a.name) && a.name.name === name
  );
  if (!attr?.value) return undefined;
  if (t.isStringLiteral(attr.value)) return attr.value.value;
  if (
    t.isJSXExpressionContainer(attr.value) &&
    t.isStringLiteral(attr.value.expression)
  ) {
    return attr.value.expression.value;
  }
  if (
    t.isJSXExpressionContainer(attr.value) &&
    t.isTemplateLiteral(attr.value.expression) &&
    attr.value.expression.quasis.length === 1
  ) {
    return attr.value.expression.quasis[0].value.cooked ?? undefined;
  }
  return undefined;
}

function extractFormFields(path: any): FormField[] {
  const fields: FormField[] = [];
  path.traverse({
    JSXOpeningElement(inner: any) {
      const name = getJSXElementName(inner.node.name);
      if (!name || !["input", "Input", "select", "Select", "textarea", "Textarea"].includes(name))
        return;
      const attrs = inner.node.attributes.filter(
        (a: any): a is t.JSXAttribute => t.isJSXAttribute(a)
      );
      const fieldName = getAttrValue(attrs, "name");
      if (fieldName) {
        fields.push({
          name: fieldName,
          type: getAttrValue(attrs, "type") || "text",
          required: attrs.some(
            (a: t.JSXAttribute) =>
              t.isJSXIdentifier(a.name) && a.name.name === "required"
          ),
          placeholder: getAttrValue(attrs, "placeholder"),
        });
      }
    },
  });
  return fields;
}

function isInsideJSX(path: any): boolean {
  let current = path.parentPath;
  while (current) {
    if (
      t.isJSXElement(current.node) ||
      t.isJSXFragment(current.node) ||
      t.isJSXExpressionContainer(current.node)
    ) {
      return true;
    }
    current = current.parentPath;
  }
  return false;
}

function extractConditionText(node: Node, source: string): string | undefined {
  if (node.start != null && node.end != null) {
    return source.slice(node.start, node.end);
  }
  if (t.isIdentifier(node)) return node.name;
  return undefined;
}

function extractJSXNames(node: Node): string[] {
  const names: string[] = [];
  if (t.isJSXElement(node)) {
    const name = getJSXElementName(node.openingElement.name);
    if (name) names.push(name);
  }
  if (t.isJSXFragment(node)) {
    for (const child of node.children) {
      if (t.isJSXElement(child)) {
        const name = getJSXElementName(child.openingElement.name);
        if (name) names.push(name);
      }
    }
  }
  return names;
}

function detectApiCall(call: t.CallExpression, source: string): ApiCall | null {
  // fetch("url", { method: "POST" })
  if (t.isIdentifier(call.callee) && call.callee.name === "fetch") {
    return parseFetchCall(call, source);
  }

  // axios.post("url", data)
  if (
    t.isMemberExpression(call.callee) &&
    t.isIdentifier(call.callee.object) &&
    call.callee.object.name === "axios" &&
    t.isIdentifier(call.callee.property)
  ) {
    const method = call.callee.property.name.toUpperCase();
    const endpoint = extractFirstArgString(call, source);
    return endpoint ? { method, endpoint } : null;
  }

  // Server action calls or mutation hooks — detect by naming patterns
  if (t.isIdentifier(call.callee)) {
    const name = call.callee.name;
    if (/^(use)?mutation/i.test(name) || /^(create|update|delete|submit|send)/i.test(name)) {
      return { method: "INFERRED", endpoint: `[${name}]` };
    }
  }

  return null;
}

function parseFetchCall(call: t.CallExpression, source: string): ApiCall | null {
  const endpoint = extractFirstArgString(call, source);
  if (!endpoint) return null;

  let method = "GET";
  if (call.arguments[1] && t.isObjectExpression(call.arguments[1])) {
    const methodProp = call.arguments[1].properties.find(
      (p): p is t.ObjectProperty =>
        t.isObjectProperty(p) &&
        t.isIdentifier(p.key) &&
        p.key.name === "method"
    );
    if (methodProp && t.isStringLiteral(methodProp.value)) {
      method = methodProp.value.value.toUpperCase();
    }
  }

  return { method, endpoint };
}

function extractFirstArgString(call: t.CallExpression, source: string): string | null {
  const firstArg = call.arguments[0];
  if (!firstArg) return null;
  if (t.isStringLiteral(firstArg)) return firstArg.value;
  if (t.isTemplateLiteral(firstArg) && firstArg.quasis.length > 0) {
    return firstArg.quasis.map((q) => q.value.cooked).join("[dynamic]");
  }
  // For identifiers/expressions, return the source text
  if (firstArg.start != null && firstArg.end != null) {
    return `[${source.slice(firstArg.start, firstArg.end)}]`;
  }
  return null;
}
