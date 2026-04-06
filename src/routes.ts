import { resolve, relative, dirname, basename, sep } from "path";
import { existsSync } from "fs";
import type { DiscoveredFile, Route } from "./types.js";

/**
 * Extract routes from a Next.js App Router project.
 *
 * Convention: app/some/path/page.tsx → route "/some/path"
 * Dynamic segments: app/[slug]/page.tsx → route "/[slug]"
 * Layouts detected by layout.tsx files alongside pages.
 */
export function extractNextRoutes(files: DiscoveredFile[], sourceDir: string): Route[] {
  const root = resolve(sourceDir);
  const pageFiles = files.filter((f) => /\/page\.(tsx|jsx|ts|js)$/.test(f.path));
  const layoutFiles = new Set(
    files.filter((f) => /\/layout\.(tsx|jsx|ts|js)$/.test(f.path)).map((f) => f.path)
  );

  const routes: Route[] = [];

  for (const file of pageFiles) {
    const rel = relative(root, file.path);
    // Strip "app/" prefix and "/page.tsx" suffix to get the route path
    const segments = rel.split(sep);
    const appIndex = segments.indexOf("app");
    if (appIndex === -1) continue;

    const routeSegments = segments.slice(appIndex + 1, -1); // drop "app" and "page.tsx"

    // Strip Next.js route groups (parenthesized segments like (app), (sidebar), (public))
    const cleanSegments = routeSegments.filter((s) => !s.startsWith("(") || !s.endsWith(")"));
    const routePath = "/" + cleanSegments.join("/") || "/";

    // Find the closest layout file
    const dir = dirname(file.path);
    const layoutFile = findClosestLayout(dir, root, layoutFiles);

    // Extract component name from file (use clean segments without route groups)
    const componentName = deriveComponentName(cleanSegments);

    routes.push({
      path: routePath === "/" ? "/" : routePath,
      filePath: file.path,
      componentName,
      isDynamic: routeSegments.some((s) => s.startsWith("[") && s.endsWith("]")),
      children: [],
      layoutFile,
    });
  }

  // Sort by path depth (shallow first) for readability
  routes.sort((a, b) => a.path.split("/").length - b.path.split("/").length);

  return routes;
}

function findClosestLayout(
  dir: string,
  root: string,
  layoutFiles: Set<string>
): string | undefined {
  let current = dir;
  while (current.startsWith(root)) {
    for (const ext of ["tsx", "jsx", "ts", "js"]) {
      const candidate = resolve(current, `layout.${ext}`);
      if (layoutFiles.has(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function deriveComponentName(segments: string[]): string {
  if (segments.length === 0) return "HomePage";
  return (
    segments
      .map((s) => {
        // [slug] → Slug
        const clean = s.replace(/\[|\]/g, "");
        return clean.charAt(0).toUpperCase() + clean.slice(1);
      })
      .join("") + "Page"
  );
}
