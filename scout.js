import "./apiLog.js";
import Exa from "exa-js";
import {
  DEFAULT_CHAT_MODEL,
  callGrove,
  graderCost,
  judgeConfigured,
  checkChatModel,
  publicModels,
} from "./groveModels.js";

const PROVIDERS = ["exa", "tavily"];
const PROVIDER_LABELS = { exa: "Exa", tavily: "Tavily" };
const DEFAULT_ANSWER_MODEL = DEFAULT_CHAT_MODEL;
// The answer model and the grader are different on purpose. Marketing evals keep their own default.
const DEFAULT_JUDGE_MODEL = "claude-sonnet-5-5";

// Tavily bills in credits; pay-as-you-go is $0.008 per credit.
const TAVILY_CREDIT_USD = 0.008;

// Delulu's latency limits: search alone and the full answer.
const SEARCH_LIMIT_MS = 3000;
const TOTAL_LIMIT_MS = 10000;
const MONTHLY_QUERIES = 2_000_000;

const SOURCE_CHARS = 10000;
const STORED_SOURCE_CHARS = 2500;

const CACHE_AGE_OPTIONS = [
  ["", "Use cache when available"],
  ["0", "Always fetch live"],
  ["24", "Refetch if older than 1 day"],
  ["168", "Refetch if older than 7 days"],
];
const WITHIN_OPTIONS = [["", "Any time (default)"], ["day", "Past day"], ["week", "Past week"], ["month", "Past month"], ["year", "Past year"]];

// Opens on the comparison setup. Exa lite rejects contents.maxAgeHours, so a live refetch cannot be sent on that type; the field is cleared. Tavily is the side set to always fetch live.
const SETTINGS = {
  exa: [
    { key: "type", label: "Search type", default: "lite", options: [
      ["auto", "Auto"], ["lite", "Lite, cached pages only"],
      ["deep-lite", "Deep lite"], ["deep", "Deep"],
    ] },
    { key: "numResults", label: "Number of results", default: 10, min: 1, max: 20 },
    { key: "content", label: "Page content", default: "highlights", options: [
      ["text", "Full text, up to 10,000 characters"], ["highlights", "Highlights"], ["summary", "Summary"],
    ] },
    { key: "maxAgeHours", label: "Content freshness", default: "", options: CACHE_AGE_OPTIONS },
    { key: "publishedWithin", label: "Published within", default: "", options: WITHIN_OPTIONS },
    { key: "category", label: "Category", default: "", options: [
      ["", "Any (default)"], ["news", "News"], ["company", "Company"], ["financial report", "Financial report"],
      ["people", "People"], ["publication", "Publication"], ["personal site", "Personal site"],
    ] },
  ],
  tavily: [
    { key: "searchDepth", label: "Search depth", default: "basic", options: [
      ["basic", "Basic"], ["advanced", "Advanced, 2 credits"], ["fast", "Fast"], ["ultra-fast", "Ultra-fast"],
    ] },
    { key: "maxResults", label: "Number of results", default: 10, min: 1, max: 20 },
    { key: "content", label: "Page content", default: "markdown", options: [
      ["snippets", "Relevant snippets"], ["markdown", "Full page as markdown"],
    ] },
    { key: "chunksPerSource", label: "Snippets per page", default: 3, options: [[1, "1"], [2, "2"], [3, "3"]] },
    { key: "maxAgeHours", label: "Content freshness", default: "0", options: CACHE_AGE_OPTIONS },
    { key: "timeRange", label: "Published within", default: "", options: WITHIN_OPTIONS },
    { key: "topic", label: "Topic", default: "general", options: [["general", "General (default)"], ["news", "News"], ["finance", "Finance"]] },
  ],
};

// [key, label, weight, rule sent to the grader]
const SCOUT_CRITERIA = [
  ["completeness", "Completeness", 0.4, "Covers every part of the question with all the facts a salesperson would need. A fact that another answer's sources support and this answer lacks is a miss. A confident \"no\" or \"none\" that this answer's own sources contradict is the worst miss."],
  ["accuracy", "Accuracy", 0.3, "Every claim is backed by this answer's own sources; nothing is invented, misread, or contradicted."],
  ["freshness", "Freshness", 0.2, "Uses the most recent information available and dates events; stale facts presented as current lose points."],
  ["citations", "Citations", 0.1, "Claims cite sources, and each cited source actually backs the claim."],
];

function tavilyConfigured() {
  return Boolean(process.env.TAVILY_API_KEY);
}

function providerConfigured(provider) {
  return provider === "exa" ? Boolean(process.env.EXA_API_KEY) : tavilyConfigured();
}

function scoutConfig() {
  return {
    providers: PROVIDERS.map((id) => ({ id, label: PROVIDER_LABELS[id], configured: providerConfigured(id) })),
    settings: SETTINGS,
    models: publicModels(),
    defaultModel: DEFAULT_ANSWER_MODEL,
    judge: { available: judgeConfigured(), defaultModel: DEFAULT_JUDGE_MODEL },
    criteria: SCOUT_CRITERIA.map(([key, label, weight, rule]) => ({ key, label, weight, rule })),
    limits: { searchMs: SEARCH_LIMIT_MS, totalMs: TOTAL_LIMIT_MS, monthlyQueries: MONTHLY_QUERIES },
    exaLite: { hiddenFields: ["maxAgeHours"], hiddenOptions: { content: ["summary"] } },
  };
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// Exa's lite type returns 400 for summaries and for any contents.maxAgeHours, so those are dropped when lite is picked.
function applyExaLiteRules(settings) {
  if (settings.type !== "lite") return settings;
  return { ...settings, content: settings.content === "summary" ? "text" : settings.content, maxAgeHours: "" };
}

function normalizeSettings(provider, raw = {}) {
  const settings = {};
  for (const field of SETTINGS[provider]) {
    const value = raw?.[field.key];
    if (field.options) {
      const match = field.options.find(([option]) => String(option) === String(value));
      settings[field.key] = match ? match[0] : field.default;
    } else {
      const number = Math.round(Number(value));
      settings[field.key] = Number.isFinite(number) && number >= field.min && number <= field.max ? number : field.default;
    }
  }
  return provider === "exa" ? applyExaLiteRules(settings) : settings;
}

function checkModel(model) {
  try {
    return checkChatModel(model);
  } catch {
    throw badRequest("model must be a Grove chat model id");
  }
}

function since(within) {
  const days = { day: 1, week: 7, month: 30, year: 365 }[within];
  return new Date(Date.now() - days * 86400000).toISOString();
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function searchExa(query, settings, signal) {
  const contents = settings.content === "highlights" ? { highlights: true }
    : settings.content === "summary" ? { summary: true }
    : { text: { maxCharacters: SOURCE_CHARS } };
  if (settings.maxAgeHours !== "") contents.maxAgeHours = Number(settings.maxAgeHours);
  const options = { type: settings.type, numResults: settings.numResults, contents, signal, timeout: settings.type.startsWith("deep") ? 90000 : 30000 };
  if (settings.category) options.category = settings.category;
  if (settings.publishedWithin) options.startPublishedDate = since(settings.publishedWithin);
  const response = await new Exa(undefined, undefined, { warnings: "silent" }).search(query, options);
  return {
    sources: (response.results ?? []).map((result) => ({
      title: result.title || result.url,
      url: result.url,
      publishedDate: result.publishedDate ?? null,
      content: (Array.isArray(result.highlights) && result.highlights.length ? result.highlights.join(" … ") : result.summary || result.text || "").slice(0, SOURCE_CHARS),
    })),
    cost: response.costDollars?.total ?? 0,
    meta: { requestId: response.requestId, resolvedSearchType: response.resolvedSearchType ?? null },
  };
}

async function searchTavily(query, settings, signal) {
  if (!tavilyConfigured()) {
    const error = new Error("TAVILY_API_KEY is not set on the server, so Tavily searches are off.");
    error.statusCode = 503;
    throw error;
  }
  const body = {
    query,
    search_depth: settings.searchDepth,
    topic: settings.topic,
    max_results: settings.maxResults,
    include_published_date: true,
    include_usage: true,
  };
  if (settings.searchDepth !== "ultra-fast") body.chunks_per_source = settings.chunksPerSource;
  if (settings.content === "markdown") body.include_raw_content = "markdown";
  if (settings.timeRange) body.time_range = settings.timeRange;
  if (settings.maxAgeHours !== "") body.max_age_hours = Number(settings.maxAgeHours);
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.detail?.error ?? data?.detail ?? data?.error ?? "";
    throw new Error(`Tavily search failed (${response.status}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""})`);
  }
  const credits = data.usage?.credits ?? (settings.searchDepth === "advanced" ? 2 : 1);
  return {
    sources: (data.results ?? []).map((result) => ({
      title: result.title || result.url,
      url: result.url,
      publishedDate: result.published_date ?? null,
      content: String((settings.content === "markdown" && result.raw_content) || result.content || "").slice(0, SOURCE_CHARS),
    })),
    cost: credits * TAVILY_CREDIT_USD,
    meta: { requestId: data.request_id ?? null, credits, responseTime: data.response_time ?? null },
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function answerSystem() {
  return [
    `You are Delulu Scout, a research assistant for B2B salespeople. Today is ${today()}.`,
    "Answer the question using only the numbered sources. Cite every factual sentence with source numbers like [1] or [2][4].",
    "Answer every part of the question; when there are several parts, give each its own short bullet or paragraph.",
    "Give dates for events, prefer the most recent information, and say when sources disagree.",
    "If the sources don't cover a part, say so for that part. Never answer \"no\" or \"none\" unless a source says so: missing evidence is not evidence of absence.",
    "Keep it under 250 words. Plain text only: no headings, no bold.",
  ].join("\n");
}

function sourcesBlock(sources, chars = SOURCE_CHARS) {
  if (!sources.length) return "(no sources were returned)";
  return sources.map((source, index) => [
    `[${index + 1}] ${source.title}`,
    `URL: ${source.url}`,
    `Published: ${source.publishedDate ? String(source.publishedDate).slice(0, 10) : "unknown"}`,
    String(source.content ?? "").slice(0, chars),
  ].join("\n")).join("\n\n");
}

async function runScout({ query, provider, settings, model, signal }) {
  const started = Date.now();
  const base = { provider, settings, model };
  let search;
  try {
    search = await (provider === "exa" ? searchExa : searchTavily)(query, settings, signal);
  } catch (error) {
    return { ...base, error: errorText(error), searchMs: Date.now() - started, totalMs: Date.now() - started };
  }
  const searchMs = Date.now() - started;
  const sources = search.sources.map((source) => ({ ...source, content: source.content.slice(0, STORED_SOURCE_CHARS) }));
  try {
    const answer = await callGrove({
      purpose: "answer",
      model,
      system: answerSystem(),
      prompt: `Question: ${query}\n\nSources:\n${sourcesBlock(search.sources)}`,
      maxTokens: 6000,
      timeoutMs: 60000,
      signal,
    });
    const llmCost = graderCost(model, answer.usage);
    const totalMs = Date.now() - started;
    return {
      ...base,
      answer: answer.stopReason === "max_tokens" ? `${answer.text} (cut off at the token limit)` : answer.text,
      sources,
      usage: answer.usage,
      searchMs,
      llmMs: totalMs - searchMs,
      totalMs,
      searchCost: search.cost,
      llmCost,
      totalCost: search.cost + llmCost,
      meta: search.meta,
      context: search.sources,
    };
  } catch (error) {
    return { ...base, sources, searchMs, totalMs: Date.now() - started, searchCost: search.cost, totalCost: search.cost, error: errorText(error), meta: search.meta };
  }
}

function readProviders(raw) {
  const providers = (Array.isArray(raw) ? raw : [raw]).map(String).filter((id, index, list) => PROVIDERS.includes(id) && list.indexOf(id) === index);
  if (!providers.length) throw badRequest("Pick Exa, Tavily, or both.");
  return providers;
}

async function scoutSearch(body, signal) {
  const query = String(body?.query ?? "").trim();
  if (query.length < 3 || query.length > 1000) throw badRequest("The question needs 3 to 1,000 characters.");
  const providers = readProviders(body?.providers);
  const model = checkModel(body?.model ?? DEFAULT_ANSWER_MODEL);
  const settings = Object.fromEntries(providers.map((provider) => [provider, normalizeSettings(provider, body?.settings?.[provider])]));
  const runs = await Promise.all(providers.map((provider) => runScout({ query, provider, settings: settings[provider], model, signal })));
  return { query, providers, model, runs: Object.fromEntries(runs.map(({ context, ...run }) => [run.provider, run])) };
}

// Scout eval cases

function validateScoutCase(raw) {
  const id = String(raw?.id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id)) throw badRequest("id must be 2-61 lowercase letters, digits, or dashes.");
  const query = String(raw?.query ?? "").trim();
  if (query.length < 5 || query.length > 1000) throw badRequest("The query needs 5 to 1,000 characters.");
  const kind = String(raw?.kind ?? "").trim().slice(0, 40) || "general";
  const mustInclude = (Array.isArray(raw?.mustInclude) ? raw.mustInclude : String(raw?.mustInclude ?? "").split("\n"))
    .map((fact) => String(fact).trim()).filter(Boolean);
  if (mustInclude.length > 10 || mustInclude.some((fact) => fact.length > 200)) throw badRequest("Use at most 10 must-include facts, each under 200 characters.");
  const caseDef = { id, query, kind, mustInclude };
  if (raw?.sources !== undefined) caseDef.sources = cleanSources(raw.sources);
  return caseDef;
}

function cleanSources(raw) {
  if (!Array.isArray(raw)) throw badRequest("sources must be a list.");
  return raw.slice(0, 4).map((source) => {
    const url = String(source?.url ?? "").trim();
    const title = String(source?.title ?? "").trim().slice(0, 180);
    const seen = String(source?.seen ?? "").trim();
    if (!/^https:\/\/\S{8,500}$/.test(url)) throw badRequest("Each source needs an https URL.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(seen)) throw badRequest("Each source needs the date you checked it, as YYYY-MM-DD.");
    return { url, title, seen };
  });
}

const JUDGE_SYSTEM = "You grade answers from a research assistant for B2B salespeople. Be strict and literal. Reply with JSON only.";

function judgePrompt(caseDef, labelled) {
  const criteria = SCOUT_CRITERIA.map(([key, , weight, rule]) => `- ${key} (${Math.round(weight * 100)}%): ${rule}`).join("\n");
  const facts = caseDef.mustInclude.length
    ? `Must-include facts (accept paraphrases). These were checked before either search ran and are known to be true: ${caseDef.mustInclude.map((fact, index) => `(${index + 1}) ${fact}`).join(" ")}`
    : "There are no must-include facts for this question; judge completeness from the question and the sources.";
  const checked = (caseDef.sources ?? []).map((source) => `${source.title || source.url} (${source.url}), checked ${source.seen}`).join("; ");
  const answers = labelled.map(({ label, run }) => [
    `=== Answer ${label} ===`,
    run.answer || "(no answer)",
    "",
    `Sources for answer ${label}, exactly as the writer saw them:`,
    sourcesBlock(run.context ?? run.sources ?? []),
  ].join("\n")).join("\n\n");
  const shape = labelled.map(({ label }) =>
    `"${label}": {"completeness": 1-5, "accuracy": 1-5, "freshness": 1-5, "citations": 1-5, "must_include": [${caseDef.mustInclude.map(() => "true or false").join(", ")}], "own_source_denial": true or false, "missed_known_fact": true or false, "false_negative": true or false, "missed_facts": ["short fact"], "reason": "under 30 words"}`
  ).join(", ");
  return [
    `Today is ${today()}. A salesperson asked: ${caseDef.query}`,
    labelled.length > 1 ? "The same model wrote each answer from different search results. Use every answer's sources to find facts an answer missed." : "",
    "",
    facts,
    checked ? `Pages the facts were checked against: ${checked}` : "",
    "",
    "Score each answer from 1 (poor) to 5 (excellent) on:",
    criteria,
    "Set own_source_denial to true only when THIS answer says something did not happen or does not exist, and a source listed under THIS answer shows that it did. Do not use the other answer's sources for this flag.",
    "Set missed_known_fact to true only when THIS answer says something did not happen, does not exist, or cannot be determined, and a must-include fact says that it did.",
    "Set false_negative to the same value as own_source_denial. List up to 5 missed_facts.",
    "",
    answers,
    "",
    `Reply with only this JSON: {${shape}${labelled.length > 1 ? `, "better": ${labelled.map(({ label }) => `"${label}"`).join(" or ")} or "tie"` : ""}}`,
  ].filter((line) => line !== null).join("\n");
}

function qualityOf(grade) {
  const weighted = SCOUT_CRITERIA.reduce((sum, [key, , weight]) => sum + weight * grade[key], 0);
  return Math.round(((weighted - 1) / 4) * 100);
}

function readGrade(raw, mustCount) {
  if (!raw || typeof raw !== "object") return null;
  const grade = {};
  for (const [key] of SCOUT_CRITERIA) {
    const score = Number(raw[key]);
    if (!(score >= 1 && score <= 5)) return null;
    grade[key] = score;
  }
  const must = Array.isArray(raw.must_include) ? raw.must_include.slice(0, mustCount).map((hit) => hit === true) : [];
  return {
    ...grade,
    quality: qualityOf(grade),
    mustInclude: must,
    mustHits: must.filter(Boolean).length,
    ownSourceDenial: raw.own_source_denial === true || (raw.own_source_denial == null && raw.false_negative === true),
    missedKnownFact: raw.missed_known_fact === true,
    falseNegative: raw.own_source_denial === true || (raw.own_source_denial == null && raw.false_negative === true),
    missedFacts: Array.isArray(raw.missed_facts) ? raw.missed_facts.map(String).slice(0, 5) : [],
    reason: typeof raw.reason === "string" ? raw.reason : "",
  };
}

// Answers are shuffled and labelled A/B so the grader can't favour a provider by name or position.
async function judgeScout(caseDef, runs, model, signal) {
  const graded = PROVIDERS.filter((provider) => runs[provider] && runs[provider].answer);
  if (!graded.length) return { grades: {}, better: null, error: "no answers to grade" };
  const order = graded.slice().sort(() => Math.random() - 0.5);
  const labelled = order.map((provider, index) => ({ provider, label: String.fromCharCode(65 + index), run: runs[provider] }));
  let result;
  try {
    result = await callGrove({ purpose: "grade", model, system: JUDGE_SYSTEM, prompt: judgePrompt(caseDef, labelled), maxTokens: 8000, timeoutMs: 90000, signal });
  } catch (error) {
    return { grades: {}, better: null, error: errorText(error) };
  }
  const usage = result.usage;
  const cost = graderCost(model, usage);
  let parsed = null;
  try {
    parsed = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] ?? "null");
  } catch {
    parsed = null;
  }
  if (!parsed) return { grades: {}, better: null, usage, cost, error: "grader did not return JSON" };
  const grades = {};
  for (const { provider, label } of labelled) {
    const grade = readGrade(parsed[label], caseDef.mustInclude.length);
    if (grade) grades[provider] = grade;
  }
  const betterLabel = parsed.better;
  const better = labelled.length < 2 ? null : betterLabel === "tie" ? "tie" : labelled.find((entry) => entry.label === betterLabel)?.provider ?? null;
  return { grades, better, labels: Object.fromEntries(labelled.map(({ provider, label }) => [provider, label])), usage, cost, error: Object.keys(grades).length ? null : "grader skipped the scores" };
}

async function runScoutCase(caseDef, { providers, settings, model, judge, judgeModel, signal }) {
  const started = Date.now();
  const list = await Promise.all(providers.map((provider) => runScout({ query: caseDef.query, provider, settings: settings[provider], model, signal })));
  const runs = Object.fromEntries(list.map((run) => [run.provider, run]));
  const verdict = judge ? await judgeScout(caseDef, runs, judgeModel, signal) : { grades: {}, better: null, error: "grader is off" };
  return {
    id: caseDef.id,
    query: caseDef.query,
    kind: caseDef.kind,
    mustInclude: caseDef.mustInclude,
    sources: caseDef.sources ?? [],
    runs: Object.fromEntries(list.map(({ context, ...run }) => [run.provider, run])),
    grades: verdict.grades,
    better: verdict.better,
    labels: verdict.labels ?? null,
    judgeError: verdict.error ?? null,
    judgeCost: verdict.cost ?? 0,
    durationMs: Date.now() - started,
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function round(value, digits = 1) {
  return value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
}

function summarizeScout(results, providers) {
  const byProvider = {};
  for (const provider of providers) {
    const runs = results.map((result) => result.runs[provider]).filter(Boolean);
    const ok = runs.filter((run) => !run.error);
    const grades = results.map((result) => result.grades[provider]).filter(Boolean);
    const searchMs = runs.map((run) => run.searchMs).filter((ms) => typeof ms === "number");
    const totalMs = ok.map((run) => run.totalMs);
    const cost = average(ok.map((run) => run.totalCost));
    byProvider[provider] = {
      queries: runs.length,
      errors: runs.length - ok.length,
      graded: grades.length,
      quality: round(average(grades.map((grade) => grade.quality))),
      criteria: Object.fromEntries(SCOUT_CRITERIA.map(([key]) => [key, round(average(grades.map((grade) => grade[key])), 2)])),
      falseNegatives: grades.filter((grade) => grade.ownSourceDenial || (grade.ownSourceDenial == null && grade.falseNegative)).length,
      ownSourceDenials: grades.filter((grade) => grade.ownSourceDenial || (grade.ownSourceDenial == null && grade.falseNegative)).length,
      missedKnownFacts: grades.filter((grade) => grade.missedKnownFact).length,
      mustHits: grades.reduce((sum, grade) => sum + grade.mustHits, 0),
      mustTotal: grades.reduce((sum, grade) => sum + grade.mustInclude.length, 0),
      wins: results.filter((result) => result.better === provider).length,
      searchMs: { p50: percentile(searchMs, 50), p95: percentile(searchMs, 95), p99: percentile(searchMs, 99) },
      totalMs: { p50: percentile(totalMs, 50), p95: percentile(totalMs, 95), p99: percentile(totalMs, 99) },
      searchWithinLimit: searchMs.length ? round((searchMs.filter((ms) => ms <= SEARCH_LIMIT_MS).length / searchMs.length) * 100, 0) : null,
      totalWithinLimit: totalMs.length ? round((totalMs.filter((ms) => ms <= TOTAL_LIMIT_MS).length / totalMs.length) * 100, 0) : null,
      searchCost: average(ok.map((run) => run.searchCost)),
      llmCost: average(ok.map((run) => run.llmCost)),
      costPerQuery: cost,
      monthlyCost: cost === null ? null : cost * MONTHLY_QUERIES,
    };
  }
  const kinds = [...new Set(results.map((result) => result.kind))];
  const byKind = kinds.map((kind) => {
    const rows = results.filter((result) => result.kind === kind);
    return {
      kind,
      queries: rows.length,
      quality: Object.fromEntries(providers.map((provider) => [provider, round(average(rows.map((row) => row.grades[provider]?.quality).filter((value) => typeof value === "number")))])),
    };
  });
  return {
    providers,
    totalQueries: results.length,
    ties: results.filter((result) => result.better === "tie").length,
    judgeCost: results.reduce((sum, result) => sum + (result.judgeCost || 0), 0),
    searchCost: results.reduce((sum, result) => sum + providers.reduce((inner, provider) => inner + (result.runs[provider]?.searchCost || 0), 0), 0),
    llmCost: results.reduce((sum, result) => sum + providers.reduce((inner, provider) => inner + (result.runs[provider]?.llmCost || 0), 0), 0),
    byProvider,
    byKind,
  };
}

export {
  PROVIDERS, scoutConfig, providerConfigured, normalizeSettings, checkModel, readProviders,
  scoutSearch, validateScoutCase, runScoutCase, summarizeScout, DEFAULT_ANSWER_MODEL, DEFAULT_JUDGE_MODEL,
};
