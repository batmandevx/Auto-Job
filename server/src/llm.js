// Provider-agnostic chat completion that always returns parsed JSON.
// Supported: gemini (native API), ollama (local), openai (any OpenAI-compatible API:
// OpenAI, Groq, LM Studio...), anthropic.

const provider = () => (process.env.LLM_PROVIDER || 'ollama').toLowerCase();

// OpenAI-compatible providers that can be used directly (LLM_PROVIDER=openrouter) and as
// FALLBACK_PROVIDERS when the primary provider is out of quota, down or its key is dead.
const COMPAT_PROVIDERS = {
  groq: { base: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY', model: 'GROQ_MODEL', defaultModel: 'openai/gpt-oss-120b' },
  openrouter: { base: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY', model: 'OPENROUTER_MODEL', defaultModel: 'google/gemma-4-31b-it:free' },
  nvidia: { base: 'https://integrate.api.nvidia.com/v1', key: 'NVIDIA_API_KEY', model: 'NVIDIA_MODEL', defaultModel: 'deepseek-ai/deepseek-v4.1-flash' },
  huggingface: { base: 'https://router.huggingface.co/v1', key: 'HUGGINGFACE_API_KEY', model: 'HUGGINGFACE_MODEL', defaultModel: '' },
  litellm: { base: 'http://localhost:4000/v1', key: 'LITELLM_API_KEY', model: 'LITELLM_MODEL', defaultModel: 'bedrock-nova-2-lite' },
};
const compatCfg = (name) => {
  const c = COMPAT_PROVIDERS[name];
  return c && { base: name === 'litellm' ? (process.env.LITELLM_BASE_URL || c.base) : c.base, key: process.env[c.key] || '', model: process.env[c.model] || c.defaultModel };
};

export function describeProvider() {
  const p = provider();
  const compat = compatCfg(p);
  if (compat) return { provider: p, model: compat.model || `(set ${COMPAT_PROVIDERS[p].model})` };
  if (p === 'gemini') return { provider: p, model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' };
  if (p === 'ollama') return { provider: p, model: process.env.OLLAMA_MODEL || 'qwen3.5:9b' };
  if (p === 'anthropic') return { provider: p, model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5' };
  return { provider: p, model: process.env.OPENAI_MODEL || 'gpt-4o-mini' };
}

// Quality-critical calls (resume parsing, tailoring, cover letters) can run on a DIFFERENT, stronger model
// than the fast one used for form answers: set HEAVY_LLM_PROVIDER (gemini / anthropic / openai / ollama /
// groq / openrouter / nvidia / huggingface / litellm) and the matching *_HEAVY_MODEL. Without it, "heavy"
// only picks GEMINI_HEAVY_MODEL inside the Gemini path.
export function describeHeavy() {
  const p = (process.env.HEAVY_LLM_PROVIDER || provider()).toLowerCase();
  const compat = compatCfg(p);
  if (compat) return { provider: p, model: compat.model, dedicated: !!process.env.HEAVY_LLM_PROVIDER };
  const model = p === 'gemini' ? (process.env.GEMINI_HEAVY_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash')
    : p === 'ollama' ? (process.env.OLLAMA_HEAVY_MODEL || process.env.OLLAMA_MODEL || 'qwen3.5:9b')
    : p === 'anthropic' ? (process.env.ANTHROPIC_HEAVY_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5')
    : (process.env.OPENAI_HEAVY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini');
  return { provider: p, model, dedicated: !!process.env.HEAVY_LLM_PROVIDER };
}

// heavy: true marks quality-critical calls (resume parsing / tailoring) that may use a stronger model.
// images: base64 JPEG screenshots, for the visual page check (Gemini only).
// search: Gemini answers with Google Search grounding; the result gets a `_sources` list ({ title, url }).
// How many AI requests today (resets at midnight), shown in the panel so a free quota doesn't run out by surprise.
const usage = { day: new Date().toDateString(), calls: 0, failed: 0 };
export function aiUsage() {
  if (usage.day !== new Date().toDateString()) Object.assign(usage, { day: new Date().toDateString(), calls: 0, failed: 0 });
  return { calls: usage.calls, failed: usage.failed };
}
export async function chatJSON(system, user, { temperature = 0.2, heavy = false, budgetMs, images = [], search = false } = {}) {
  try {
    return await primaryJSON(system, user, { temperature, heavy, budgetMs, images, search });
  } catch (e) {
    // Quota gone, key dead or everything overloaded: walk the configured OpenAI-compatible fallbacks
    // (FALLBACK_PROVIDERS=groq,openrouter,litellm,...). The visual check and research stay Gemini-only.
    if (images.length || search) throw e;
    const fb = await fallbackJSON(system, user, temperature, e);
    if (fb !== undefined) return fb;
    throw e;
  }
}

// FALLBACK_PROVIDERS, tried in order, each only when its API key is set. Returns undefined when none worked.
async function fallbackJSON(system, user, temperature, primaryError) {
  const names = (process.env.FALLBACK_PROVIDERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return undefined;
  let lastError;
  for (const name of names) {
    const cfg = compatCfg(name);
    if (!cfg) { lastError = new Error(`unknown fallback provider "${name}"`); continue; }
    if (!cfg.key) { lastError = new Error(`${name}: ${COMPAT_PROVIDERS[name].key} is not set in server/.env`); continue; }
    try {
      const text = await openaiCompatible(system, user, temperature, cfg.model, cfg);
      console.warn(`Primary AI failed (${String(primaryError?.message || '').slice(0, 80)}); used fallback provider "${name}" (${cfg.model})`);
      lastFallbackAt = Date.now();
      return parseJSON(text);
    } catch (err) {
      lastError = err;
      console.warn(`Fallback provider "${name}" failed: ${String(err.message).slice(0, 100)}`);
    }
  }
  console.warn(`All fallback providers failed; last error: ${String(lastError?.message).slice(0, 120)}`);
  return undefined;
}

async function primaryJSON(system, user, { temperature, heavy, budgetMs, images, search }) {
  const p = provider();
  // A stronger, separate model for quality-critical calls, when HEAVY_LLM_PROVIDER is configured.
  const heavyProvider = heavy && !images.length && !search ? (process.env.HEAVY_LLM_PROVIDER || '').toLowerCase() : '';
  if (heavyProvider && heavyProvider !== p) {
    if (heavyProvider === 'gemini') return parseJSON((await gemini(system, user, temperature, true, budgetMs ?? 150000)).text);
    if (heavyProvider === 'ollama') return parseJSON(await ollama(system, user, temperature, process.env.OLLAMA_HEAVY_MODEL));
    if (heavyProvider === 'anthropic') return parseJSON(await anthropic(system, user, temperature, process.env.ANTHROPIC_HEAVY_MODEL));
    const heavyCfg = compatCfg(heavyProvider);
    if (heavyCfg) return parseJSON(await openaiCompatible(system, user, temperature, heavyCfg.model, heavyCfg));
    return parseJSON(await openaiCompatible(system, user, temperature, process.env.OPENAI_HEAVY_MODEL));
  }
  let text;
  if (search) {
    if (p !== 'gemini') throw new Error('Company research needs Gemini (LLM_PROVIDER=gemini): it searches the web with Google Search');
    const out = await gemini(system, user, temperature, heavy, budgetMs ?? 90000, [], true);
    return { ...parseJSON(out.text), _sources: out.sources };
  }
  if (images.length && p !== 'gemini') throw new Error('The visual check needs Gemini (LLM_PROVIDER=gemini)');
  if (p === 'gemini') {
    try {
      text = (await gemini(system, user, temperature, heavy, budgetMs ?? (heavy ? 150000 : 60000), images)).text;
    } catch (e) {
      // Free Gemini quota gone or every model overloaded: use the local Ollama model if it's running.
      if (images.length || process.env.OLLAMA_FALLBACK === 'off' || !(await ollamaUp())) throw e;
      console.warn(`Gemini unavailable (${String(e.message).slice(0, 80)}); using local Ollama instead`);
      lastFallbackAt = Date.now();
      text = await ollama(system, user, temperature);
    }
  }
  else if (p === 'ollama') text = await ollama(system, user, temperature, heavy ? process.env.OLLAMA_HEAVY_MODEL : undefined);
  else if (p === 'anthropic') text = await anthropic(system, user, temperature, heavy ? process.env.ANTHROPIC_HEAVY_MODEL : undefined);
  else {
    const cfg = compatCfg(p);
    text = await openaiCompatible(system, user, temperature, cfg ? cfg.model : heavy ? process.env.OPENAI_HEAVY_MODEL : undefined, cfg || undefined);
  }
  return parseJSON(text);
}

// Free-tier Gemini keys get a small daily quota *per model*, so calls rotate through a chain of models:
// a model that is out of quota (429) or overloaded (503) is skipped for a while and the next one is tried.
const DEFAULT_CHAIN = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-flash-latest'];
const resting = new Map(); // model -> timestamp until which it is skipped

export function geminiStatus() {
  const now = Date.now();
  return [...resting].filter(([, t]) => t > now).map(([m, t]) => ({ model: m, minutes: Math.round((t - now) / 60000) }));
}

async function gemini(system, user, temperature, heavy, budgetMs, images = [], search = false) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set in server/.env');
  const main = (heavy && process.env.GEMINI_HEAVY_MODEL) || describeProvider().model;
  const extra = (process.env.GEMINI_FALLBACK_MODELS || process.env.GEMINI_FALLBACK_MODEL || '').split(',').map((m) => m.trim());
  const chain = [...new Set([main, ...extra, ...DEFAULT_CHAIN].filter(Boolean))];
  const ready = chain.filter((m) => !(resting.get(m) > Date.now()));
  // Search grounding is refused outright on free keys: try one model and fail fast, without resting any model.
  const models = search ? (ready.length ? ready : chain).slice(0, 1) : ready.length ? ready : chain; // everything resting: try anyway
  // Each model gets at most its own timeout, and the whole chain at most budgetMs, so nothing ever "hangs".
  const perModel = Number(process.env.GEMINI_TIMEOUT_MS || (heavy ? 90000 : 25000));
  const deadline = Date.now() + budgetMs;
  let lastError;
  for (const model of models) {
    const timeoutMs = Math.min(perModel, deadline - Date.now());
    if (timeoutMs < 3000) {
      lastError ||= new Error('the AI took too long');
      break;
    }
    // Gemini 3.x thinks at length by default; "low" keeps quality and cuts latency a lot.
    const thinkingConfig = /gemini-[3-9]/.test(model) ? { thinkingLevel: 'low' } : { thinkingBudget: heavy ? 2048 : 0 };
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }, ...images.map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } }))] }],
          // Search grounding can't be combined with JSON mode: the prompt asks for JSON and parseJSON extracts it.
          ...(search ? { tools: [{ google_search: {} }] } : {}),
          generationConfig: { temperature, ...(search ? {} : { responseMimeType: 'application/json' }), maxOutputTokens: 32768, thinkingConfig },
        }),
      });
    } catch (e) {
      lastError = new Error(`Gemini ${model} ${e.name === 'TimeoutError' ? `took over ${timeoutMs / 1000}s` : e.message}`);
      console.warn(`${lastError.message}; trying next model`);
      resting.set(model, Date.now() + 5 * 60_000);
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('');
      const sources = (data.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map((c) => c.web).filter((w) => w?.uri).map((w) => ({ title: w.title || '', url: w.uri }));
      if (text) return { text, sources };
      lastError = new Error(`Gemini returned no text (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`);
      continue;
    }
    const body = await res.text();
    lastError = new Error(`Gemini ${model} ${res.status}: ${body.slice(0, 200)}`);
    if (search) break; // the caller falls back to its own sources
    if (res.status === 429) {
      // Daily quota: rest until it resets (midnight Pacific); per-minute limit: a minute.
      const daily = /PerDay/i.test(body);
      resting.set(model, Date.now() + (daily ? msUntilPacificMidnight() : 65_000));
      console.warn(`Gemini ${model}: ${daily ? 'daily' : 'per-minute'} quota used up; switching model`);
    } else if (res.status === 503 || res.status === 500) {
      resting.set(model, Date.now() + 2 * 60_000);
      console.warn(`Gemini ${model} overloaded (${res.status}); switching model`);
    } else if (res.status === 404) {
      resting.set(model, Date.now() + 24 * 3600_000);
    } else break; // bad key / bad request: another model will not help
  }
  if (/429/.test(lastError?.message)) throw new Error('All Gemini models are out of free quota for today. Add billing to the key, or set LLM_PROVIDER=ollama in server/.env to use the local model.');
  throw lastError;
}

function msUntilPacificMidnight() {
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const midnight = new Date(pt);
  midnight.setHours(24, 0, 5, 0);
  return midnight - pt;
}

let lastFallbackAt = 0;
export const usedFallbackRecently = () => Date.now() - lastFallbackAt < 10 * 60_000;
async function ollamaUp() {
  const base = process.env.OLLAMA_URL || 'http://localhost:11434';
  return fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
}

async function ollama(system, user, temperature, model) {
  const base = process.env.OLLAMA_URL || 'http://localhost:11434';
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || process.env.OLLAMA_MODEL || 'qwen3.5:9b', // also used as the fallback when the provider is Gemini
      stream: false,
      format: 'json',
      think: false, // reasoning models (qwen3.x, deepseek-r1) are much slower with it and the JSON is no better
      options: { temperature, num_ctx: 16384 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  }).catch((e) => {
    throw new Error(`Cannot reach Ollama at ${base} (is "ollama serve" running?): ${e.message}`);
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).message.content;
}

async function openaiCompatible(system, user, temperature, model, cfg) {
  if (cfg && !cfg.model) throw new Error(`${cfg.base}: no model configured (set its *_MODEL in server/.env)`);
  const base = cfg?.base || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg ? cfg.key : process.env.OPENAI_API_KEY || ''}`,
    },
    signal: AbortSignal.timeout(Number(process.env.OPENAI_TIMEOUT_MS || 60000)),
    body: JSON.stringify({
      model: model || cfg?.model || describeProvider().model,
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

async function anthropic(system, user, temperature, model) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || describeProvider().model,
      max_tokens: 8000,
      temperature,
      system: `${system}\nRespond with a single JSON object and nothing else.`,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.map((c) => c.text || '').join('');
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Models sometimes wrap JSON in prose or code fences; grab the outermost object.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(`Model did not return JSON: ${text.slice(0, 200)}`);
  }
}
