# web-agent

Generate `browser.txt` — a machine-readable site map for AI agents — from your React/Next.js source code.

Instead of making browser agents guess what's on a page (slow, brittle, expensive), give them a complete map of every interaction, form, navigation element, and conditional on your site. Think `robots.txt` but for AI agents that actually use your website.

## The Problem

Browser agents are bad when they don't need to be. They:
- Waste tokens describing screenshots to figure out what a button does
- Fail on dynamic content, modals, and conditional rendering
- Can't plan multi-step workflows because they can't see the whole site
- Break constantly when UI changes

## The Solution

`web-agent` statically analyzes your codebase to produce `browser.txt`, a JSON document that describes every page, interaction, form, and navigation element on your site with semantic descriptions.

```
web-agent analyze ./my-nextjs-app -o browser.txt
```

An AI agent with `browser.txt` knows:
- Every page and what it does
- Every button and what happens when you click it
- Every form and what fields it needs
- What's conditionally rendered and when
- Authentication requirements per page
- API endpoints triggered by interactions

## How It Works

**Layer 1: AST Extraction** — Babel parses your JSX/TSX and extracts interactive elements, event handlers, forms, links, conditional rendering, and API calls (including Convex patterns).

**Layer 2: LLM Reasoning** — Every page's extracted structure + source code is sent to GPT-4o-mini to produce semantic descriptions an agent can act on. The LLM answers: "what does this button do from the user's perspective?"

**Layer 3: Browser Agent** — A Playwright-powered agent reads `browser.txt` and navigates your site deterministically using LLM-guided step planning.

## Install

```bash
npm install
npx playwright install chromium
```

## Usage

### Generate browser.txt

```bash
# Full analysis with LLM enrichment
web-agent analyze ./src -o browser.txt -k sk-your-openai-key

# AST-only (no API key needed, faster, less useful)
web-agent analyze ./src -o browser.txt --no-llm

# Use a specific model
web-agent analyze ./src -m gpt-4o
```

### Navigate a website

```bash
# Single task navigation
web-agent navigate http://localhost:3000 "Navigate to the donations page" \
  -s browser.txt -k sk-your-openai-key

# Non-headless (watch the browser)
web-agent navigate http://localhost:3000 "Fill out the profile form" \
  -s browser.txt --no-headless
```

### Run evals

```bash
# Run a batch of navigation tasks and get metrics
web-agent eval evals/tasks.json -s browser.txt -o report.json

# Eval tasks file format:
# [{ "name": "...", "goal": "...", "startUrl": "...", "successCriteria": { ... } }]
```

## Environment Variables

Set `OPENAI_API_KEY` in your environment or a `.env` file to skip the `-k` flag.

## browser.txt Format

```json
{
  "version": "1.0",
  "generatedAt": "2025-01-01T00:00:00.000Z",
  "site": "my-app",
  "pages": [
    {
      "path": "/dashboard",
      "description": "Overview of donation activity for logged-in users.",
      "preconditions": ["User must be logged in"],
      "interactions": [
        {
          "element": "button",
          "label": "Refresh Status",
          "description": "Refreshes the account status from Stripe.",
          "action": {
            "type": "api_call",
            "method": "POST",
            "endpoint": "/api/stripe/getAccountStatus",
            "result": "Account status is refreshed on the dashboard."
          },
          "confidence": "verified"
        }
      ],
      "forms": [...],
      "navigation": [...],
      "conditionalElements": [...]
    }
  ]
}
```

## Supported Frameworks

- **Next.js App Router** — Full support (file-based routing, dynamic routes, layouts)
- React Router — Coming soon
- Vue/Nuxt — Coming soon

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode (coming soon)
```

## License

MIT
