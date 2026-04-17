# GenLea Agent Framework

Located at `packages/shared/src/agent/`. Importable from any service via `@genlea/shared`.

---

## Why it exists

The original discovery and enrichment agents used LangGraph's ReAct loop directly. This worked
but had two problems:

1. **Full HTML was passed to the LLM.** A single Playwright page scrape could be 50–200KB of
   HTML. At ~4 chars/token that's 12,000–50,000 tokens per page — burning context window fast
   on a 32K model and causing Ollama to OOM on 18GB RAM.

2. **No separation of concerns.** The LLM could theoretically output Playwright code and the
   system would run it. This is unsafe and undebuggable.

The new framework enforces a strict contract:
- **LLM decides what to do** (planner) — outputs JSON only, never code
- **Deterministic functions do the work** (executor) — Playwright, API calls, etc.
- **DOM is summarized before the LLM sees it** — 50KB HTML → ~300 token structured summary

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      Agent Loop                          │
│                                                          │
│   ┌─────────┐    ┌──────────┐    ┌──────────────────┐   │
│   │  Memory │───▶│ Planner  │───▶│    Executor      │   │
│   │ (state) │    │  (LLM)   │    │ (Playwright/API) │   │
│   └────▲────┘    └──────────┘    └────────┬─────────┘   │
│        │                                  │              │
│        └──────────── result ──────────────┘              │
│                                                          │
│   DOM Summarizer sits between the page and the Planner   │
│   LangSmith wraps the entire loop as a named trace run   │
└──────────────────────────────────────────────────────────┘
```

---

## Module by module

### 1. `dom-summarizer.ts` — HTML → structured summary

**Problem:** A typical /team page is 80–200KB of HTML tags, inline CSS, tracking scripts,
and navigation boilerplate. The LLM doesn't need any of that.

**What it does:** Runs `page.evaluate()` — a function that executes inside the browser's JS
context — and extracts only the elements that matter for decision-making:

```ts
interface DomSummary {
  url:      string;                           // current page URL
  title:    string;                           // <title> tag
  buttons:  string[];                         // clickable button texts (max 10)
  inputs:   { selector, placeholder, type }[];// form fields with usable selectors (max 8)
  links:    { text, href }[];                 // anchor text + href (max 15)
  headings: string[];                         // h1–h4 text (max 8)
  text:     string;                           // body innerText, truncated to 800 chars
}
```

**Token impact:**
- Before: 50KB HTML page ≈ 12,000 tokens
- After: DomSummary JSON ≈ 250–400 tokens
- Reduction: **96–98%** per page

**Key detail:** The summarizer strips `type="hidden"` inputs and only includes inputs that have
a usable selector (`#id`, `[name=...]`, or `[placeholder=...]`). This prevents the LLM from
hallucinating selectors — it can only click or type into elements that are concretely described
in the summary.

---

### 2. `memory.ts` — agent state

The memory object carries everything the LLM needs between steps:

```ts
interface AgentMemory {
  goal:    string;                    // the original goal string, never changes
  url:     string;                    // updated every step from dom.url
  history: AgentMessage[];            // rolling log of past actions + results
  state:   Record<string, unknown>;   // arbitrary data scrapers can store mid-run
}
```

**`buildContext(memory, maxHistory = 5)`** serialises this into a human-readable string that
goes into the LLM prompt:

```
Goal: Find the CEO name and email on acme.com/team
Current URL: https://acme.com/team
Recent steps:
  navigate({ url: "https://acme.com" }) → Navigated to https://acme.com
  click({ selector: "#team-link" }) → Clicked #team-link
State: {}
```

**Why a rolling window?** Sending the entire history grows the prompt linearly with each step.
With `maxHistory = 5`, the context stays constant regardless of run length. Older steps are
dropped — only recent context matters for navigation decisions.

---

### 3. `planner.ts` — LLM with strict JSON output

The planner wraps `buildLlm()` (which reads `AGENT_LLM_PROVIDER` / `AGENT_LLM_MODEL` from env)
and enforces a strict output contract via a system prompt and zod validation.

**System prompt enforces:**
- ONE action per response
- Output ONLY a JSON object — no explanation, no markdown, no code
- Never guess selectors — only use selectors listed in the current DOM summary
- Two termination actions: `done` (success) and `fail` (cannot complete)

**Output schema (zod-validated):**
```ts
{
  action:    string,   // tool name: navigate | click | type | extract_text | done | fail
  input:     object,   // tool-specific params
  reasoning: string,   // one sentence explanation (logged, not used for execution)
}
```

**Fallback:** If the LLM returns anything that doesn't parse as valid JSON or fails zod
validation, the planner returns `{ action: "fail", reasoning: "LLM returned unparseable..." }`
rather than throwing. The agent loop records this and terminates cleanly.

**LLM JSON reliability:** Ollama models (qwen3.5, llama3) sometimes wrap JSON in markdown
code fences (` ```json ... ``` `). The planner strips these before parsing.

---

### 4. `executor.ts` — tool registry

The executor is a plain registry of named async functions. The LLM never writes Playwright code
— it names a tool and provides inputs. The tool implementation is deterministic TypeScript.

**Default tools (Playwright):**

| Tool | Input | What it does |
|---|---|---|
| `navigate` | `{ url }` | `page.goto(url, { waitUntil: 'domcontentloaded' })` |
| `click` | `{ selector }` | `waitForSelector` then `page.click` |
| `type` | `{ selector, text }` | `waitForSelector` then `page.fill` (replaces, doesn't append) |
| `extract_text` | `{ selector }` | `textContent()`, truncated to 2000 chars |
| `scroll` | `{ direction, amount }` | `window.scrollBy` via evaluate |
| `wait` | `{ ms }` | `setTimeout` capped at 5000ms |

**Custom tools:** Pass `extraTools` to `runAgentLoop()`. Each tool receives `(input, page)`
and returns `{ success, output, error? }`. This is how scrapers add domain-specific tools
(e.g., `save_contact`, `check_enrichment_progress`) that write to MongoDB.

**Error handling:** A tool that throws returns `{ success: false, error: message }` —
it does NOT propagate. The agent loop decides what to do with failures (retry, record, abort).

---

### 5. `agent-loop.ts` — the ReAct loop

The main orchestration function. Implements:

```
Thought (plan) → Action (execute) → Observation (record) → repeat
```

**Full step sequence:**

```
while step < maxSteps AND now < deadline:
  step++

  1. summarizeDom(page)           → DomSummary   (fails gracefully → abort)
  2. memory.url = dom.url
  3. planNextAction(memory, dom)  → AgentAction  (fails gracefully → abort)
  4. if action == 'done'  → return { success: true }
     if action == 'fail'  → return { success: false }
  5. executeAction(action, page)  → ToolResult
  6. recordStep(memory, ...)      → appends to history
  7. if !result.success:
       retries++
       if retries > maxRetries → abort
     else:
       retries = 0

return { success: false, reason: 'Max steps' | 'Timeout' }
```

**Guardrails:**

| Guard | Default | What it prevents |
|---|---|---|
| `maxSteps` | 15 | infinite loops / runaway LLM reasoning |
| `maxRetries` | 2 | hammering a broken selector repeatedly |
| `timeoutMs` | 5 min | getting stuck on a slow page load |

**Why retries resets to 0 on success:** The guard is for *consecutive* failures. If the agent
clicks something wrong, then navigates successfully, the retry counter resets. This prevents
one early failure from aborting an otherwise healthy run.

---

### 6. `langsmith.ts` — observability

Two utility wrappers built on `langsmith/traceable`:

**`wrapTraceable(name, fn)`** — wraps any async function as a LangSmith chain run.
Used to wrap `_runAgentLoop` so the entire goal execution appears as one named run.

**`wrapToolTraceable(name, fn)`** — same but marks the run type as `tool` for better
categorisation in the LangSmith dashboard.

Both are no-ops when `LANGCHAIN_TRACING_V2` is not `true` — zero overhead in production
without tracing configured.

**What gets traced automatically:**
Because `buildLlm()` returns a LangChain model, every `.invoke()` call is auto-instrumented
by LangChain's callback system and appears as a child span under the parent run.

**What you see in LangSmith:**
```
agent-loop: "Find the CEO name on acme.com/team"
  ├── ChatOllama.invoke (step 1 — planner call)
  │     input:  { messages: [system, human] }
  │     output: { action: "navigate", input: { url: "..." } }
  ├── ChatOllama.invoke (step 2)
  │     output: { action: "click", input: { selector: "#team-link" } }
  └── ChatOllama.invoke (step 3)
        output: { action: "done", reasoning: "Found: Jane Smith, jane@acme.com" }
```

**To enable:**
```env
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=ls__...
LANGCHAIN_PROJECT=genlea
```

---

## Data flow (end to end)

```
Goal string
    │
    ▼
runAgentLoop(goal, page, opts)
    │
    ├── createMemory(goal)          → AgentMemory { goal, url: '', history: [], state: {} }
    │
    └── Loop:
         │
         ├── summarizeDom(page)     → DomSummary (250-400 tokens, never raw HTML)
         │       │
         │       └── Sets memory.url = dom.url
         │
         ├── planNextAction(memory, dom, toolKeys)
         │       │
         │       ├── buildContext(memory)       → prompt string with goal + last 5 steps
         │       ├── LLM.invoke([system, human]) → raw JSON string
         │       └── zod.parse(JSON.parse(raw))  → AgentAction or { action: 'fail' }
         │
         ├── if action == 'done' | 'fail' → return result
         │
         ├── executeAction(action, page, registry)
         │       │
         │       └── registry[action.action](action.input, page) → ToolResult
         │
         └── recordStep(memory, action, result) → appends to history (rolling window)
```

---

## How to use

### Basic usage (new Playwright scraper)

```ts
import { runAgentLoop } from '@genlea/shared';

const result = await runAgentLoop(
  'Navigate to acme.com/team and extract the name and email of the CEO',
  page,
  { maxSteps: 10, timeoutMs: 2 * 60_000 },
);

if (result.success) {
  console.log('Done in', result.steps, 'steps:', result.reason);
} else {
  console.warn('Failed:', result.reason);
}
```

### Adding domain-specific tools

```ts
import { runAgentLoop, createDefaultPlaywrightTools } from '@genlea/shared';
import type { ToolRegistry } from '@genlea/shared';

const extraTools: ToolRegistry = {
  save_contact: async ({ name, email, role }) => {
    await contactRepository.upsert({ fullName: String(name), email: String(email), role: String(role) });
    return { success: true, output: `Saved contact: ${name}` };
  },
  check_goal_met: async (_, page) => {
    const count = await contactRepository.countForCompany(companyId);
    return { success: true, output: count >= 1 ? 'goal_met' : 'goal_not_met' };
  },
};

const result = await runAgentLoop(goal, page, { extraTools, maxSteps: 15 });
```

### Wrapping your own function with LangSmith tracing

```ts
import { wrapTraceable } from '@genlea/shared';

const myTracedFn = wrapTraceable('my-scraper', async (domain: string) => {
  // all LangChain calls inside here are auto-traced as child spans
  const result = await runAgentLoop(...);
  return result;
});
```

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AGENT_LLM_PROVIDER` | No | `ollama` | `ollama` / `groq` / `anthropic` |
| `AGENT_LLM_MODEL` | No | `qwen3.5` | Model override |
| `OLLAMA_BASE_URL` | No | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_NUM_CTX` | No | `32768` | Context window — reduce to `8192` for M3 Pro |
| `OLLAMA_NUM_PREDICT` | No | `8192` | Max output tokens |
| `GROQ_API_KEY` | If Groq | — | Groq cloud API key |
| `ANTHROPIC_API_KEY` | If Anthropic | — | Anthropic cloud API key |
| `LANGCHAIN_TRACING_V2` | No | — | Set `true` to enable LangSmith |
| `LANGCHAIN_API_KEY` | If tracing | — | LangSmith API key |
| `LANGCHAIN_PROJECT` | No | `default` | Project name in LangSmith dashboard |

---

## File map

```
packages/shared/src/agent/
  index.ts          — barrel export for all public types and functions
  dom-summarizer.ts — Page → DomSummary (runs in browser context)
  memory.ts         — AgentMemory: create, record, buildContext
  planner.ts        — LLM wrapper: DomSummary + memory → AgentAction (JSON, zod-validated)
  executor.ts       — ToolRegistry: default Playwright tools + executeAction
  agent-loop.ts     — ReAct loop: maxSteps / maxRetries / timeout guardrails
  langsmith.ts      — wrapTraceable / wrapToolTraceable (no-op without API key)
```
