// Provider-agnostic chat completion that always returns parsed JSON.
// Supported: gemini (native API), ollama (local), openai (any OpenAI-compatible API:
// OpenAI, Groq, LM Studio...), anthropic.

const provider = () => (process.env.LLM_PROVIDER || 'ollama').toLowerCase();

export function describeProvider() {
  const p = provider();
  if (p === 'gemini') return { provider: p, model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' };
  if (p === 'ollama') return { provider: p, model: process.env.OLLAMA_MODEL || 'qwen3.5:9b' };
  if (p === 'anthropic') return { provider: p, model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5' };
  return { provider: p, model: process.env.OPENAI_MODEL || 'gpt-4o-mini' };
}

// heavy: true marks quality-critical calls (resume parsing / tailoring) that may use a stronger model.
export async function chatJSON(system, user, { temperature = 0.2, heavy = false, budgetMs } = {}) {
  const p = provider();
  let text;
  if (p === 'gemini') {
    try {
      text = await gemini(system, user, temperature, heavy, budgetMs ?? (heavy ? 150000 : 60000));
    } catch (e) {
      // Free Gemini quota gone or every model overloaded: use the local Ollama model if it's running.
      if (process.env.OLLAMA_FALLBACK === 'off' || !(await ollamaUp())) throw e;
      console.warn(`Gemini unavailable (${String(e.message).slice(0, 80)}); using local Ollama instead`);
      lastFallbackAt = Date.now();
      text = await ollama(system, user, temperature);
    }
  }
  else if (p === 'ollama') text = await ollama(system, user, temperature);
  else if (p === 'anthropic') text = await anthropic(system, user, temperature);
  else text = await openaiCompatible(system, user, temperature);
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

async function gemini(system, user, temperature, heavy, budgetMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set in server/.env');
  const main = (heavy && process.env.GEMINI_HEAVY_MODEL) || describeProvider().model;
  const extra = (process.env.GEMINI_FALLBACK_MODELS || process.env.GEMINI_FALLBACK_MODEL || '').split(',').map((m) => m.trim());
  const chain = [...new Set([main, ...extra, ...DEFAULT_CHAIN].filter(Boolean))];
  const ready = chain.filter((m) => !(resting.get(m) > Date.now()));
  const models = ready.length ? ready : chain; // everything resting: try anyway
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
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature, responseMimeType: 'application/json', maxOutputTokens: 32768, thinkingConfig },
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
      if (text) return text;
      lastError = new Error(`Gemini returned no text (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`);
      continue;
    }
    const body = await res.text();
    lastError = new Error(`Gemini ${model} ${res.status}: ${body.slice(0, 200)}`);
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

async function ollama(system, user, temperature) {
  const base = process.env.OLLAMA_URL || 'http://localhost:11434';
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'qwen3.5:9b', // also used as the fallback when the provider is Gemini
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

async function openaiCompatible(system, user, temperature) {
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
    },
    body: JSON.stringify({
      model: describeProvider().model,
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

async function anthropic(system, user, temperature) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: describeProvider().model,
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
