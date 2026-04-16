# GenLea — Optimization TODO

Two independent tracks: fine-tune Qwen3:8b for scraping tasks, and add LangSmith tracing to
understand where the agents are failing. Both feed into the broader goal of running reliably
on a MacBook M3 Pro 18GB without OOM crashes.

---

## Track 1 — Fine-tune Qwen3:8b for web scraping (QLoRA via MLX)

**Goal:** A custom model that is much better at HTML extraction, contact parsing, company
normalization, and deciding when a page has no useful data — all the things the current
general-purpose LLM gets wrong or wastes tokens on.

**Why MLX and not QLoRA/bitsandbytes?**
bitsandbytes requires CUDA (NVIDIA GPU). M3 Pro uses Apple Silicon with unified memory.
MLX is Apple's own ML framework built for this exact hardware — it uses the unified memory
pool efficiently and has native LoRA fine-tuning support. `mlx-lm` is the right tool here.

---

### Step 1 — Build the training dataset from MongoDB

The raw material already exists in `scrape_logs.agentSteps` — every tool call the agent
made, the result it got, and whether the run succeeded. Mine this.

```bash
# Script to write: scripts/export-finetune-data.ts
# For each successful scrape_log (status: 'success'):
#   - Pull the agentSteps
#   - For each step where tool = 'scrape_source' or 'playwright_scrape_url',
#     pair the raw HTML input with the normalized JSON output the agent produced
#   - Output as JSONL: { instruction, input, output }
npm run db:export-finetune    # script to create
```

Target examples to collect:

| Task | Input | Output |
|---|---|---|
| Company extraction | Raw Wellfound/LinkedIn HTML | `{ name, domain, employeeCount, techStack[] }` |
| Contact extraction | /team or /about page HTML | `[{ fullName, role, linkedinUrl }]` |
| Tech stack parsing | Job description text | `["nodejs", "typescript", "react"]` |
| Defunct detection | Landing page HTML | `{ defunct: true, reason: "parked domain" }` |
| HQ country detection | About page / Clearbit blob | `{ hqCountry: "US", city: "San Francisco" }` |

Aim for **500+ examples per task type**. More data = better adapter, but 500 is usable.
Filter out failed/partial runs — only use `status: 'success'` logs as ground truth.

Format each example as ChatML (what Qwen3 expects):

```jsonl
{"messages": [
  {"role": "system", "content": "You extract structured company data from HTML. Return only valid JSON."},
  {"role": "user", "content": "<HTML TRUNCATED TO 2000 CHARS>"},
  {"role": "assistant", "content": "{\"name\":\"Acme\",\"domain\":\"acme.io\",\"employeeCount\":45,\"techStack\":[\"react\",\"nodejs\"]}"}
]}
```

Save to `finetune/data/train.jsonl` and `finetune/data/valid.jsonl` (90/10 split).

---

### Step 2 — Install MLX-LM

```bash
cd finetune/           # create this directory
python -m venv .venv
source .venv/bin/activate
pip install mlx-lm     # Apple's LLM fine-tuning toolkit
```

Verify MLX can see your GPU cores:
```python
import mlx.core as mx
print(mx.default_device())   # should say: Device(gpu, 0)
```

---

### Step 3 — Download the base model (4-bit quantized)

MLX community maintains pre-quantized models. Use the 4-bit version — it fits in ~5GB of
the 18GB unified memory pool, leaving room for the training overhead.

```bash
mlx_lm.convert \
  --hf-path Qwen/Qwen3-8B \
  --mlx-path models/qwen3-8b-4bit \
  -q                           # 4-bit quantization
```

Or pull directly from mlx-community (pre-converted, faster):
```bash
# In Python:
from mlx_lm import load
model, tokenizer = load("mlx-community/Qwen3-8B-4bit")
```

---

### Step 4 — LoRA fine-tune

```bash
mlx_lm.lora \
  --model mlx-community/Qwen3-8B-4bit \
  --train \
  --data finetune/data \
  --iters 1000 \
  --batch-size 4 \
  --lora-layers 16 \
  --learning-rate 1e-5 \
  --val-batches 25 \
  --save-every 200 \
  --adapter-path finetune/adapters/qwen3-8b-scraper
```

**Memory budget on 18GB M3 Pro:**
- Base model (4-bit): ~5GB
- LoRA adapter parameters: ~200MB
- Optimizer state (Adam): ~400MB
- Activations + batch: ~2-3GB
- Total: ~8-9GB → should be fine, leaves ~9GB for OS + other processes

**If you get OOM:**
- Drop `--batch-size` to 2
- Drop `--lora-layers` to 8
- Close Chrome/other apps during training

Training at 1000 iters with batch=4 takes roughly 45-90 min on M3 Pro.
Watch the validation loss — stop early if it plateaus.

---

### Step 5 — Evaluate the adapter

```bash
mlx_lm.generate \
  --model mlx-community/Qwen3-8B-4bit \
  --adapter-path finetune/adapters/qwen3-8b-scraper \
  --prompt "Extract company data from this HTML: <div class='company'>Acme Corp, 50 employees...</div>"
```

Compare the output against the base model (without `--adapter-path`).
If the adapter is better on your held-out `valid.jsonl` examples, proceed to deploy.

---

### Step 6 — Deploy via Ollama

Fuse the adapter weights into the base model:

```bash
mlx_lm.fuse \
  --model mlx-community/Qwen3-8B-4bit \
  --adapter-path finetune/adapters/qwen3-8b-scraper \
  --save-path finetune/fused/qwen3-8b-scraper
```

Convert the fused MLX model to GGUF (Ollama's format):

```bash
# llama.cpp needed for conversion
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp && pip install -r requirements.txt
python convert_hf_to_gguf.py ../finetune/fused/qwen3-8b-scraper --outtype q4_K_M
# → produces qwen3-8b-scraper-q4_K_M.gguf
```

Create an Ollama model:

```bash
# finetune/Modelfile
cat > finetune/Modelfile << 'EOF'
FROM ./qwen3-8b-scraper-q4_K_M.gguf
PARAMETER num_ctx 8192
PARAMETER temperature 0.1
SYSTEM "You are a web scraping assistant. Extract structured JSON data from HTML and text. Be precise and return only valid JSON."
EOF

ollama create genlea-scraper -f finetune/Modelfile
```

Update `.env`:
```env
AGENT_LLM_PROVIDER=ollama
AGENT_LLM_MODEL=genlea-scraper
OLLAMA_NUM_CTX=8192
```

---

## Track 2 — LangSmith tracing

**Goal:** See exactly what the agents are doing — which tools fail, how many tokens each
scraper burns, where the reasoning goes wrong, which companies hit `maxIterations`.

The agents already use LangChain (`createAgent`, `@langchain/core`, `@langchain/langgraph`).
LangSmith auto-instruments all of this with zero code changes — just env vars.

---

### Step 1 — Create a LangSmith account

Go to https://smith.langchain.com → sign in with GitHub → create a project called `genlea`.
Get your API key from Settings → API Keys.

---

### Step 2 — Add to `.env`

```env
# LangSmith tracing
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=ls__...
LANGCHAIN_PROJECT=genlea
LANGCHAIN_ENDPOINT=https://api.smith.langchain.com
```

That's it — no code changes. Every `agent.invoke()`, every tool call, every LLM call is
automatically traced from this point.

---

### Step 3 — What to look for in the dashboard

**Agent runs view** (`/projects/genlea/runs`):

| Signal | What it tells you |
|---|---|
| Runs hitting `recursionLimit` | Agent is looping — check which tool keeps being retried |
| High `durationMs` on a specific tool | That scraper is the bottleneck (likely Playwright) |
| `status: error` on `scrape_source` | Scraper is broken — check which source + error message |
| Token usage per run | Which runs are burning the most tokens (= cost / Ollama slowdown) |
| `available: false` frequency | Which API keys are missing and causing constant fallback |

**Filter by agent type:**
- `discovery:linkedin:*` — see all LinkedIn discovery runs
- `enrichment:*` — see all enrichment runs, sorted by duration

**Key traces to investigate first:**
1. Runs where `companiesFound = 0` and `status = 'partial'` — agent ran but saved nothing
2. Enrichment runs that hit `maxIterations = 20` — agent is stuck in a loop
3. Any run where `disqualify_company` was called — check the reason and see if it's correct

---

### Step 4 — Add run names for better filtering (optional, one line each)

In [discovery.agent.ts](services/svc-discovery/src/agents/discovery.agent.ts):
```ts
// Add to the invoke options — LangSmith picks this up automatically
{ recursionLimit: maxIterations * 2 + 4, runName: agentName }
```

In [enrichment.agent.ts](services/svc-enrichment/src/agents/enrichment.agent.ts):
```ts
{ recursionLimit: maxIterations * 2 + 4, runName: agentName, timeoutMs: 12 * 60 * 1000 }
```

This makes runs searchable by `discovery:linkedin:abc12345` in LangSmith instead of a raw UUID.

---

## Track 3 — M3 Pro 18GB memory optimization

The crash risk comes from running everything at once: Ollama (5GB) + 3 Playwright browsers
(~1.2GB) + Docker mongo+redis (~800MB) + 4 Node services (~800MB) = ~8-10GB used, but
spikes when multiple enrichment jobs run in parallel and each spawns a browser.

### Settings to set in `.env`

```env
# Playwright — biggest memory hog. 1 concurrent browser = ~400MB peak.
# Default is 3 — on 18GB drop to 1 for dev, 2 max for production runs.
MAX_CONCURRENT_BROWSERS=1

# Ollama context window — this is the #1 VRAM cost, not the model weights.
# 32768 tokens × ~2 bytes = ~64MB per active inference. For scraping tasks
# you don't need long context. 8192 is plenty and cuts memory 4x.
OLLAMA_NUM_CTX=8192
OLLAMA_NUM_PREDICT=2048
```

### Settings to set via API (no restart needed)

```bash
# Reduce worker concurrency — default may be 2-3, drop to 1 each in dev
curl -X PATCH http://localhost:4000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{
    "workerConcurrencyDiscovery": 1,
    "workerConcurrencyEnrichment": 1,
    "workerConcurrencyScoring": 2
  }'
```

### Development workflow (don't run everything at once)

In dev, you don't need all 4 services running simultaneously. The queues persist in Redis —
jobs don't disappear when workers are stopped.

```bash
# Typical dev session:
docker-compose up -d mongo redis          # always on
npm run dev -w services/svc-api           # always on (need the dashboard)

# Run discovery to fill the queue, then stop it:
npm run dev -w services/svc-discovery     # run, let it seed, Ctrl+C

# Then run enrichment to process what was found:
npm run dev -w services/svc-enrichment    # run until queue drains, Ctrl+C

# Then scoring:
npm run dev -w services/svc-scoring       # fast, runs in seconds
```

This staggers the memory peaks instead of hitting them all at once.

### Docker memory limits (optional, prevents runaway containers)

Add to `docker-compose.yml` under each service:
```yaml
deploy:
  resources:
    limits:
      memory: 512m    # svc-api, svc-scoring
    limits:
      memory: 1g      # svc-discovery, svc-enrichment (need more for Playwright)
```

### Ollama model choice

| Model | VRAM (4-bit) | Speed on M3 Pro | Recommendation |
|---|---|---|---|
| `qwen3:4b` | ~2.5GB | Fast (~30 tok/s) | Use for dev / high-volume runs |
| `qwen3:8b` | ~5GB | Medium (~15 tok/s) | Default — good balance |
| `qwen3:14b` | ~8GB | Slow (~8 tok/s) | Only if quality is clearly better |
| `qwen3:32b` | ~20GB | Unusable | Exceeds 18GB — don't use |

Switch model without restart:
```bash
curl -X PATCH http://localhost:4000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"agentLlmModel": "qwen3:4b"}'
```

---

## Priority order

1. **LangSmith first** — 10 min setup, zero code changes, immediately shows you what's broken.
   Do this before anything else. You need real data to know where to focus.

2. **M3 optimizations** — set `MAX_CONCURRENT_BROWSERS=1` and `OLLAMA_NUM_CTX=8192` today.
   Instant improvement, no risk.

3. **Fine-tuning** — do this after you have LangSmith data showing which extraction tasks the
   current model fails at. Training without knowing the failure mode is guessing.
