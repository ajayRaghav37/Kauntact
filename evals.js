import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { research, structuredFrom, groundingFrom, signalWindow, outputSchema, EFFORTS, effortOption, timeoutFor } from "./index.js";

// Cases live in MongoDB (evalCases) and are edited from the Evals tab.
// expect: verdict, maxCostDollars, and maxLatencyMs are required on every case.
// verdict may be a list when the right answer depends on whether the person posted this month.
// maxCostDollars and maxLatencyMs are the limits at low effort; limitsFor scales them for other efforts.
// role ("cro", "vp_engineering", or "cto") and personName are optional.

const EXPECTED_ROLES = {
  cro: /\bchief revenue officer\b|\bcro\b/i,
  vp_engineering: /\b(vp|svp|evp|vice president)\b[^;]*\bengineering\b/i,
  cto: /\bchief technology officer\b|\bcto\b/i,
};

const LAYOFF = /\b(lay-?offs?|laid off|job cuts|workforce reduction|reduction in force|downsizing)\b/i;
// Leadership means VP and above: C-suite, president, (S/E)VP, head of a function, or founder. Directors and managers do not count.
const ROLE = /\bchief\b(?! of staff)|\bc[a-z]{1,2}o\b|\bpresident\b|\b(vp|svp|evp)\b|\bhead of\b|\b(co-?)?founder\b|\bexco\b|\bexecutive committee\b/i;

const pass = (name, detail = "") => ({ name, status: "pass", detail });
const fail = (name, detail) => ({ name, status: "fail", detail });
const warn = (name, detail) => ({ name, status: "warn", detail });
const skip = (name, detail = "") => ({ name, status: "skip", detail });

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateSchema(value, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["output is not a JSON object"];
  const errors = [];
  for (const key of schema.required) {
    if (!(key in value)) errors.push(`missing required field ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!schema.properties[key]) errors.push(`unexpected field ${key}`);
  }
  for (const [key, rule] of Object.entries(schema.properties)) {
    if (!(key in value)) continue;
    const field = value[key];
    const types = [].concat(rule.type);
    const actual = field === null ? "null" : typeof field;
    if (!types.includes(actual)) {
      errors.push(`${key} should be ${types.join(" or ")}, got ${actual}`);
      continue;
    }
    if (field === null) continue;
    if (rule.enum && !rule.enum.includes(field)) errors.push(`${key} "${field}" is not one of ${rule.enum.join(", ")}`);
    if (rule.maxLength && field.length > rule.maxLength) errors.push(`${key} is ${field.length} characters, max ${rule.maxLength}`);
    if (rule.format === "date" && !isValidDate(field)) errors.push(`${key} "${field}" is not a YYYY-MM-DD date`);
    if (rule.format === "uri" && !isHttpUrl(field)) errors.push(`${key} "${field}" is not an http(s) URL`);
  }
  return errors;
}

function checkOutput(output, { window, input = {}, expect = {}, grounding = [] }) {
  const checks = [];
  const schemaErrors = validateSchema(output, outputSchema);
  checks.push(schemaErrors.length ? fail("schema", schemaErrors.join("; ")) : pass("schema"));

  const { person_name, person_title, signal, signal_date, source_url, opener, verdict } = output ?? {};
  const complete = Boolean(person_name && signal_date && source_url);

  if (opener && !complete) {
    checks.push(fail("opener rules", "opener written without person_name, signal_date, and source_url all present"));
  } else if (opener && verdict !== "ready") {
    checks.push(fail("opener rules", `opener present but verdict is ${verdict}`));
  } else if (!opener && verdict !== "cannot_verify") {
    checks.push(fail("opener rules", `opener is null but verdict is ${verdict}`));
  } else {
    checks.push(pass("opener rules"));
  }

  if (typeof opener === "string" && opener.trim()) {
    const words = opener.trim().split(/\s+/).length;
    checks.push(words < 25 ? pass("opener length", `${words} words`) : fail("opener length", `${words} words, must be under 25`));
  } else {
    checks.push(skip("opener length", "no opener"));
  }

  if (!signal_date) {
    checks.push(skip("date window", "no signal_date"));
  } else if (!isValidDate(signal_date)) {
    checks.push(fail("date window", `"${signal_date}" is not a valid date`));
  } else if (signal_date < window.start) {
    checks.push(fail("date window", `${signal_date} is before ${window.start}`));
  } else if (signal_date > window.end) {
    checks.push(fail("date window", `${signal_date} is after today (${window.end})`));
  } else {
    checks.push(pass("date window", `${signal_date} is within ${window.start}..${window.end}`));
  }

  const signalText = [signal, opener].filter(Boolean).join(" ");
  checks.push(LAYOFF.test(signalText) ? fail("no layoff", `signal mentions a layoff: "${signalText}"`) : pass("no layoff"));

  if (input.exclusion) {
    const excluded = signalText.toLowerCase().includes(input.exclusion.toLowerCase());
    checks.push(excluded
      ? fail("exclusion", `signal is about the excluded event "${input.exclusion}"`)
      : pass("exclusion", `does not mention "${input.exclusion}"`));
  } else {
    checks.push(skip("exclusion", "no exclusion in case"));
  }

  if (verdict === "ready") {
    checks.push(ROLE.test(person_title ?? "")
      ? pass("role", person_title)
      : fail("role", `title "${person_title ?? "null"}" is not a leadership position`));
  } else {
    checks.push(skip("role", "verdict is not ready"));
  }

  if (verdict === "ready") {
    const citedUrls = grounding.flatMap((entry) => entry.urls);
    if (!citedUrls.length) checks.push(warn("grounding", "ready verdict has no grounding citations"));
    else if (source_url && !citedUrls.includes(source_url)) checks.push(warn("grounding", "source_url is not among the grounding citations"));
    else checks.push(pass("grounding", `${citedUrls.length} citation(s)`));
  } else {
    checks.push(skip("grounding", "verdict is not ready"));
  }

  if (expect.verdict) {
    const allowed = [].concat(expect.verdict);
    checks.push(allowed.includes(verdict)
      ? pass("expected verdict", verdict)
      : fail("expected verdict", `expected ${allowed.join(" or ")}, got ${verdict}`));
  }

  if (expect.role) {
    if (verdict !== "ready") {
      checks.push(skip("expected role", "verdict is not ready"));
    } else {
      checks.push(EXPECTED_ROLES[expect.role]?.test(person_title ?? "")
        ? pass("expected role", person_title)
        : fail("expected role", `expected ${expect.role}, got "${person_title ?? "null"}"`));
    }
  }

  if (expect.personName) {
    const found = String(person_name ?? "").toLowerCase();
    checks.push(found && found.includes(expect.personName.toLowerCase())
      ? pass("expected person", person_name)
      : fail("expected person", `expected ${expect.personName}, got ${person_name ?? "null"}`));
  }

  return checks;
}

function checkBudget({ cost, latencyMs }, expect = {}) {
  const checks = [];
  if (expect.maxCostDollars !== undefined) {
    if (typeof cost !== "number") checks.push(warn("cost", "run did not report costDollars.total"));
    else if (cost > expect.maxCostDollars) checks.push(fail("cost", `$${cost.toFixed(4)} is over the $${expect.maxCostDollars} limit`));
    else checks.push(pass("cost", `$${cost.toFixed(4)} ≤ $${expect.maxCostDollars}`));
  }
  if (expect.maxLatencyMs !== undefined) {
    const seconds = (latencyMs / 1000).toFixed(1);
    const limit = (expect.maxLatencyMs / 1000).toFixed(0);
    checks.push(latencyMs > expect.maxLatencyMs
      ? fail("latency", `${seconds}s is over the ${limit}s limit`)
      : pass("latency", `${seconds}s ≤ ${limit}s`));
  }
  return checks;
}

// Ultra has no factor: its limit is the run timeout.
const LATENCY_FACTOR = { auto: 4, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4 };

function limitsFor(expect, effort = "low") {
  const option = effortOption(effort);
  const maxCostDollars = option.price === null
    ? option.budgetDollars
    : Math.round((expect.maxCostDollars * option.price) / effortOption("low").price * 10000) / 10000;
  const factor = LATENCY_FACTOR[option.id];
  const maxLatencyMs = factor ? Math.min(expect.maxLatencyMs * factor, timeoutFor(option.id)) : timeoutFor(option.id);
  return { maxCostDollars, maxLatencyMs };
}

async function loadCases() {
  const { listCases } = await import("./store.js");
  return listCases();
}

const INPUT_FIELDS = ["accountName", "domain", "persona", "personName", "exclusion"];

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateCase(body) {
  const id = String(body?.id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(id)) throw invalid("id must be 2-60 lowercase letters, digits, or dashes.");
  const input = {};
  for (const field of INPUT_FIELDS) {
    const value = String(body?.input?.[field] ?? "").replace(/\s+/g, " ").trim();
    if (value.length > 200) throw invalid(`${field} must be under 200 characters.`);
    if (value) input[field] = value;
  }
  if (!input.accountName && !input.domain) throw invalid("A case needs an account name or a domain.");
  const raw = body?.expect ?? {};
  const verdicts = [].concat(raw.verdict ?? []).map(String);
  if (!verdicts.length || verdicts.some((verdict) => !["ready", "cannot_verify"].includes(verdict))) {
    throw invalid("expect.verdict must be ready, cannot_verify, or both.");
  }
  const expect = { verdict: verdicts.length === 1 ? verdicts[0] : ["ready", "cannot_verify"] };
  if (raw.role) {
    if (!EXPECTED_ROLES[raw.role]) throw invalid("expect.role must be cro, vp_engineering, or cto.");
    expect.role = raw.role;
  }
  const personName = String(raw.personName ?? "").trim();
  if (personName) expect.personName = personName.slice(0, 100);
  expect.maxCostDollars = Number(raw.maxCostDollars);
  expect.maxLatencyMs = Math.round(Number(raw.maxLatencyMs));
  if (!(expect.maxCostDollars >= 0.001 && expect.maxCostDollars <= 100)) throw invalid("expect.maxCostDollars must be between 0.001 and 100.");
  if (!(expect.maxLatencyMs >= 1000 && expect.maxLatencyMs <= 3600000)) throw invalid("expect.maxLatencyMs must be between 1000 and 3600000.");
  return { id, input, expect };
}

function assertCasesHaveExpectations(cases) {
  const missing = cases
    .map((caseDef) => ({
      id: caseDef.id,
      fields: ["verdict", "maxCostDollars", "maxLatencyMs"].filter((field) => caseDef.expect?.[field] === undefined),
    }))
    .filter((entry) => entry.fields.length);
  if (missing.length) {
    throw new Error(`Every case needs expect.verdict, maxCostDollars, and maxLatencyMs. Missing: ${missing.map((entry) => `${entry.id} (${entry.fields.join(", ")})`).join("; ")}`);
  }
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const META_KEYS = ["og:title", "og:description", "description", "twitter:title", "twitter:description", "article:published_time", "datePublished", "uploadDate", "author"];

// Pages rendered by JavaScript (YouTube, LinkedIn) carry their title, description, and date only in meta tags.
function pageMetadataFrom(html) {
  const lines = [];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) lines.push(`title: ${title}`);
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1];
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
    const value = content?.[1] ?? content?.[2];
    if (key && value && META_KEYS.includes(key) && !lines.some((line) => line.endsWith(value))) lines.push(`${key}: ${value}`);
  }
  return decodeEntities(lines.join("\n")).replace(/[ \t]+/g, " ").trim();
}

function pageTextFrom(html) {
  const body = decodeEntities(html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  const metadata = pageMetadataFrom(html);
  return (metadata ? `Page metadata:\n${metadata}\n\nPage text:\n${body}` : body).slice(0, 8000);
}

async function checkSource(output) {
  const url = output?.source_url;
  if (!url || !isHttpUrl(url)) return { check: skip("source page", "no source_url"), pageText: "" };
  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" },
    });
  } catch (error) {
    return { check: warn("source page", `could not fetch: ${error instanceof Error ? error.message : String(error)}`), pageText: "" };
  }
  if (response.status === 404 || response.status === 410) return { check: fail("source page", `${url} returned ${response.status}`), pageText: "" };
  if (!response.ok) return { check: warn("source page", `${url} returned ${response.status} (likely blocks bots)`), pageText: "" };
  const html = await response.text();
  const pageText = pageTextFrom(html);
  const lastName = String(output.person_name ?? "").trim().split(/\s+/).pop()?.toLowerCase();
  if (lastName && !html.toLowerCase().includes(lastName)) {
    return { check: warn("source page", `page loaded but does not mention "${lastName}" (may be rendered by JavaScript)`), pageText };
  }
  return { check: pass("source page", `${response.status}${lastName ? `, mentions "${lastName}"` : ""}`), pageText };
}

// Claude models on the Grove Anthropic messages endpoint, with USD prices per million input and output tokens.
const GRADER_MODELS = [
  { id: "claude-haiku-5-5", input: 0.074, output: 0.37 },
  { id: "claude-haiku-4-5", input: 0.74, output: 3.7 },
  { id: "claude-sonnet-5-5", input: 1.48, output: 7.4 },
  { id: "claude-sonnet-5", input: 1.48, output: 7.4 },
  { id: "claude-sonnet-4-6", input: 3, output: 15 },
  { id: "claude-sonnet-4-5", input: 3, output: 15 },
  { id: "claude-opus-5-5", input: 2.96, output: 14.8 },
  { id: "claude-opus-5", input: 3.7, output: 18.5 },
  { id: "claude-opus-4-8", input: 3.7, output: 18.5 },
  { id: "claude-opus-4-7", input: 5, output: 25 },
  { id: "claude-opus-4-6", input: 5, output: 25 },
  { id: "claude-opus-4-5", input: 5, output: 25 },
  { id: "claude-fable-5-2", input: 5.92, output: 29.6 },
  { id: "claude-fable-5-1", input: 7.4, output: 37 },
  { id: "claude-fable-5", input: 7.4, output: 37 },
];
const DEFAULT_JUDGE_MODEL = "claude-haiku-5-5";

function graderCost(model, usage) {
  const prices = GRADER_MODELS.find((entry) => entry.id === model);
  if (!prices || !usage) return 0;
  return ((usage.input_tokens ?? 0) * prices.input + (usage.output_tokens ?? 0) * prices.output) / 1e6;
}

// [key, check name, rule sent to the grader, short summary shown in the Evals UI]
const JUDGE_CRITERIA = [
  ["second_person", "second person", "The opener speaks directly to the person (you, your), not about them in the third person.", "opener speaks to the person (you, your)"],
  ["references_signal", "references signal", "The opener refers to the specific signal, not a generic compliment.", "names the specific signal"],
  ["signal_type", "signal type", "The signal is the person's own LinkedIn or X (Twitter) post, a talk they gave, or a funding announcement. A reply, repost, or quote post of someone else, a news article, a newsletter, or someone else's post about them does not count. A layoff never counts.", "signal is their own post, their talk, or funding news"],
  ["about_person", "about the person", "The source page shows the signal is by or about the named person at the named company. Treat a short form or nickname of the same name (Jon for Jonathan, Bob for Robert) as the same person. Use null if the source page text is missing or does not settle it.", "source page backs the person and company"],
  ["natural_tone", "natural tone", "The opener sounds like a sales rep talking: specific and plain, no hype, and no claims beyond the signal. The opener is spoken to the named person, so \"you\" means that person; crediting them with their own post or talk is correct, not a false claim.", "plain tone, no hype or extra claims"],
];

const JUDGE_SYSTEM = "You grade sales-outreach research for an evaluation suite. Be strict and literal. Reply with JSON only.";

function judgeConfigured() {
  return Boolean(process.env.GROVE_API_KEY && process.env.GROVE_ENDPOINT);
}

function buildJudgePrompt(output, pageText) {
  const criteria = JUDGE_CRITERIA.map(([key, , rule]) => `- ${key}: ${rule}`).join("\n");
  const shape = JUDGE_CRITERIA.map(([key]) => `"${key}": {"pass": true, "reason": "under 20 words"}`).join(", ");
  return [
    "Grade this research result against each criterion.",
    "",
    "Result:",
    JSON.stringify(output, null, 2),
    "",
    "Source page text (may be partial):",
    pageText ? `<<<\n${pageText}\n>>>` : "(not available: the page could not be fetched)",
    "",
    "Criteria:",
    criteria,
    "",
    `Reply with only this JSON, setting each "pass" to true or false: {${shape}}`,
    'Use "pass": null only where a criterion allows it.',
  ].join("\n");
}

function parseJudgeResponse(text) {
  const match = String(text ?? "").match(/\{[\s\S]*\}/);
  let parsed = null;
  try {
    parsed = match ? JSON.parse(match[0]) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") return [warn("judge", "grader did not return JSON")];
  return JUDGE_CRITERIA.map(([key, name]) => {
    const label = `judge: ${name}`;
    const answer = parsed[key];
    if (!answer || typeof answer !== "object") return warn(label, "grader did not answer");
    const reason = typeof answer.reason === "string" ? answer.reason : "";
    if (answer.pass === null) return skip(label, reason || "not enough evidence");
    return answer.pass === true ? pass(label, reason) : fail(label, reason || "failed");
  });
}

async function judgeOutput(output, { pageText = "", model = DEFAULT_JUDGE_MODEL } = {}) {
  if (!judgeConfigured()) return { checks: [skip("judge", "GROVE_API_KEY or GROVE_ENDPOINT is not set")] };
  if (output?.verdict !== "ready" || !output?.opener) return { checks: [skip("judge", "no opener to grade")] };
  try {
    const response = await fetch(process.env.GROVE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "api-key": process.env.GROVE_API_KEY,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system: JUDGE_SYSTEM,
        messages: [{ role: "user", content: buildJudgePrompt(output, pageText) }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { checks: [warn("judge", `grader request failed (${response.status}${body?.error?.message ? `: ${body.error.message}` : ""})`)] };
    }
    const text = (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
    return { checks: parseJudgeResponse(text), usage: body.usage ?? null };
  } catch (error) {
    return { checks: [warn("judge", `grader request failed: ${error instanceof Error ? error.message : String(error)}`)] };
  }
}

async function runCase(caseDef, options) {
  const started = Date.now();
  const effort = options.effort ?? "low";
  const judgeModel = options.judge !== false ? options.judgeModel ?? DEFAULT_JUDGE_MODEL : null;
  const limits = limitsFor(caseDef.expect, effort);
  try {
    const { run, window } = await research({ ...caseDef.input, effort }, {
      quiet: true,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutFor(effort))]) : undefined,
      log: options.log ?? (options.verbose ? undefined : () => {}),
    });
    const latencyMs = Date.now() - started;
    const reportedCost = run.costDollars?.total;
    const output = structuredFrom(run);
    const grounding = groundingFrom(run);
    const checks = checkOutput(output, { window, input: caseDef.input, expect: caseDef.expect, grounding });
    checks.push(...checkBudget({ cost: reportedCost, latencyMs }, limits));
    let pageText = "";
    if (options.sources) {
      const source = await checkSource(output);
      checks.push(source.check);
      pageText = source.pageText;
    } else {
      checks.push(skip("source page", "source fetching is off"));
    }
    let judgeUsage = null;
    if (judgeModel) {
      const judged = await judgeOutput(output, { pageText, model: judgeModel });
      checks.push(...judged.checks);
      judgeUsage = judged.usage ?? null;
    } else {
      checks.push(skip("judge", "judge is off"));
    }
    return {
      judgeUsage,
      judgeModel,
      judgeCost: graderCost(judgeModel, judgeUsage),
      effort,
      limits,
      id: caseDef.id,
      input: caseDef.input,
      expect: caseDef.expect,
      runId: run.id,
      window,
      output,
      grounding,
      checks,
      cost: typeof reportedCost === "number" ? reportedCost : 0,
      latencyMs,
      durationMs: Date.now() - started,
      passed: !checks.some((check) => check.status === "fail"),
    };
  } catch (error) {
    return {
      id: caseDef.id,
      effort,
      limits,
      judgeModel,
      judgeCost: 0,
      input: caseDef.input,
      error: error instanceof Error ? error.message : String(error),
      checks: [fail("run", error instanceof Error ? error.message : String(error))],
      cost: 0,
      durationMs: Date.now() - started,
      passed: false,
    };
  }
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

const LABEL = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" };

function printCase(result) {
  const lines = [];
  const output = result.output ?? {};
  const person = output.person_name ? `${output.person_name}${output.person_title ? ` (${output.person_title})` : ""}` : "no person";
  const summary = result.error
    ? `error: ${result.error}`
    : `${output.verdict ?? "no verdict"} · ${person} · ${output.signal_date ?? "no date"}`;
  const seconds = ((result.latencyMs ?? result.durationMs) / 1000).toFixed(1);
  lines.push(`${result.passed ? "PASS" : "FAIL"}  ${result.id}  ${summary}  $${result.cost.toFixed(4)}  ${seconds}s`);
  if (output.opener) lines.push(`      opener: ${output.opener}`);
  if (output.source_url) lines.push(`      source: ${output.source_url}`);
  for (const check of result.checks) {
    if (check.status === "skip") continue;
    lines.push(`      ${LABEL[check.status]}  ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
  }
  console.log(lines.join("\n") + "\n");
}

function summarize(results) {
  const checkTotals = {};
  for (const result of results) {
    for (const check of result.checks) {
      if (check.status === "skip") continue;
      const totals = (checkTotals[check.name] ??= { pass: 0, fail: 0, warn: 0 });
      totals[check.status] += 1;
    }
  }
  const timed = results.filter((result) => typeof result.latencyMs === "number");
  return {
    passedCases: results.filter((result) => result.passed).length,
    totalCases: results.length,
    cost: results.reduce((sum, result) => sum + result.cost, 0),
    judgeCost: results.reduce((sum, result) => sum + (result.judgeCost ?? 0), 0),
    avgLatencyMs: timed.length ? Math.round(timed.reduce((sum, result) => sum + result.latencyMs, 0) / timed.length) : null,
    checkTotals,
  };
}

function printSummary(results, window, reportPath) {
  const { checkTotals, passedCases, cost, judgeCost } = summarize(results);
  console.log(`Signal window: ${window.start} to ${window.end}`);
  console.log(`Cases passed: ${passedCases}/${results.length}`);
  const width = Math.max(0, ...Object.keys(checkTotals).map((name) => name.length)) + 1;
  for (const [name, totals] of Object.entries(checkTotals)) {
    const counted = totals.pass + totals.fail + totals.warn;
    console.log(`  ${name.padEnd(width)} ${totals.pass}/${counted} pass${totals.fail ? `, ${totals.fail} fail` : ""}${totals.warn ? `, ${totals.warn} warn` : ""}`);
  }
  console.log(`Total cost: $${cost.toFixed(4)}${judgeCost ? ` (plus $${judgeCost.toFixed(4)} for the AI grader)` : ""}`);
  if (reportPath) console.log(`Report: ${reportPath}`);
}

function parseArgs(argv) {
  const options = { ids: [], concurrency: 2, repeat: 1, sources: true, judge: true, verbose: false, selfTest: false, effort: "low", judgeModel: DEFAULT_JUDGE_MODEL, name: "" };
  for (const arg of argv) {
    if (arg === "--self-test") options.selfTest = true;
    else if (arg.startsWith("--effort=")) {
      options.effort = arg.split("=")[1];
      if (!EFFORTS.includes(options.effort)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
    } else if (arg.startsWith("--grader=")) {
      options.judgeModel = arg.split("=")[1];
      if (!GRADER_MODELS.some((model) => model.id === options.judgeModel)) throw new Error(`--grader must be one of ${GRADER_MODELS.map((model) => model.id).join(", ")}`);
    }
    else if (arg === "--no-sources") options.sources = false;
    else if (arg === "--no-judge") options.judge = false;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg.startsWith("--concurrency=")) options.concurrency = Math.max(1, Number(arg.split("=")[1]) || 1);
    else if (arg.startsWith("--repeat=")) options.repeat = Math.max(1, Number(arg.split("=")[1]) || 1);
    else if (arg.startsWith("--name=")) options.name = arg.slice("--name=".length);
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else options.ids.push(arg);
  }
  return options;
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function runSelfTests() {
  const window = signalWindow();
  const ready = {
    company: "Acme",
    person_name: "Ada Lovelace",
    person_title: "VP of Engineering",
    signal: "Spoke at a developer conference",
    signal_date: window.end,
    source_url: "https://example.com/talk",
    opener: "Loved your talk on scaling teams last week, curious how Acme is approaching it now.",
    verdict: "ready",
  };
  const notFound = {
    company: "Acme",
    person_name: null,
    person_title: null,
    signal: null,
    signal_date: null,
    source_url: null,
    opener: null,
    verdict: "cannot_verify",
  };
  const cited = [{ field: "source_url", confidence: "high", urls: ["https://example.com/talk"] }];
  const tests = [
    { name: "valid ready output passes", output: ready, grounding: cited, expectFail: [] },
    { name: "valid cannot_verify output passes", output: notFound, expectFail: [] },
    { name: "signal on the first day of the window passes", output: { ...ready, signal_date: window.start }, grounding: cited, expectFail: [] },
    { name: "signal one day before the window fails", output: { ...ready, signal_date: addDays(window.start, -1) }, grounding: cited, expectFail: ["date window"] },
    { name: "signal dated in the future fails", output: { ...ready, signal_date: addDays(window.end, 1) }, grounding: cited, expectFail: ["date window"] },
    { name: "opener without a source fails", output: { ...ready, source_url: null }, expectFail: ["opener rules"] },
    { name: "ready verdict without opener fails", output: { ...ready, opener: null }, grounding: cited, expectFail: ["opener rules"] },
    { name: "layoff signal fails", output: { ...ready, signal: "Announced layoffs across the org" }, grounding: cited, expectFail: ["no layoff"] },
    { name: "excluded event fails", input: { exclusion: "Series B" }, output: { ...ready, signal: "Announced the Series B round" }, grounding: cited, expectFail: ["exclusion"] },
    { name: "extra field fails schema", output: { ...ready, email: "ada@example.com" }, grounding: cited, expectFail: ["schema"] },
    { name: "missing verdict fails schema", output: { company: "Acme" }, expectFail: ["schema", "opener rules"] },
    { name: "25-word opener fails", output: { ...ready, opener: Array.from({ length: 25 }, () => "word").join(" ") }, grounding: cited, expectFail: ["opener length"] },
    { name: "non-leadership role fails", output: { ...ready, person_title: "Senior Software Engineer" }, grounding: cited, expectFail: ["role"] },
    { name: "director role fails", output: { ...ready, person_title: "Director of Engineering" }, grounding: cited, expectFail: ["role"] },
    { name: "chief of staff fails", output: { ...ready, person_title: "Chief of Staff" }, grounding: cited, expectFail: ["role"] },
    { name: "chief title without officer passes", output: { ...ready, person_title: "Chief Commercial and Group Exco" }, grounding: cited, expectFail: [] },
    { name: "CRO title passes", output: { ...ready, person_title: "Chief Revenue Officer" }, grounding: cited, expectFail: [] },
    { name: "CTO title passes", output: { ...ready, person_title: "CTO" }, grounding: cited, expectFail: [] },
    { name: "chief commercial officer passes", output: { ...ready, person_title: "Chief Commercial Officer" }, grounding: cited, expectFail: [] },
    { name: "VP of Technology passes", output: { ...ready, person_title: "VP of Technology" }, grounding: cited, expectFail: [] },
    { name: "expected verdict mismatch fails", expect: { verdict: "cannot_verify" }, output: ready, grounding: cited, expectFail: ["expected verdict"] },
    { name: "either-verdict case accepts cannot_verify", expect: { verdict: ["ready", "cannot_verify"], role: "cro" }, output: notFound, expectFail: [] },
    { name: "expected CRO but got VP of Engineering fails", expect: { role: "cro" }, output: ready, grounding: cited, expectFail: ["expected role"] },
    { name: "expected VP of Engineering passes", expect: { role: "vp_engineering" }, output: ready, grounding: cited, expectFail: [] },
    { name: "expected person matches", expect: { personName: "Lovelace" }, output: ready, grounding: cited, expectFail: [] },
    { name: "expected person mismatch fails", expect: { personName: "Grace Hopper" }, output: ready, grounding: cited, expectFail: ["expected person"] },
    { name: "cost and latency within limits pass", budget: { cost: 0.025, latencyMs: 20000 }, expect: { maxCostDollars: 0.05, maxLatencyMs: 60000 }, output: ready, grounding: cited, expectFail: [] },
    { name: "cost over limit fails", budget: { cost: 0.08, latencyMs: 20000 }, expect: { maxCostDollars: 0.05, maxLatencyMs: 60000 }, output: ready, grounding: cited, expectFail: ["cost"] },
    { name: "latency over limit fails", budget: { cost: 0.025, latencyMs: 61000 }, expect: { maxCostDollars: 0.05, maxLatencyMs: 60000 }, output: ready, grounding: cited, expectFail: ["latency"] },
    { name: "medium effort scales the low-effort limits", budget: { cost: 0.1, latencyMs: 100000 }, expect: limitsFor({ maxCostDollars: 0.05, maxLatencyMs: 60000 }, "medium"), output: ready, grounding: cited, expectFail: [] },
    { name: "auto effort over its budget cap fails", budget: { cost: 1.2, latencyMs: 20000 }, expect: limitsFor({ maxCostDollars: 0.05, maxLatencyMs: 60000 }, "auto"), output: ready, grounding: cited, expectFail: ["cost"] },
  ];
  const results = tests.map((test) => {
    const checks = checkOutput(test.output, { window, input: test.input, expect: test.expect, grounding: test.grounding ?? [] });
    if (test.budget) checks.push(...checkBudget(test.budget, test.expect));
    const failed = checks.filter((check) => check.status === "fail").map((check) => check.name).sort();
    const expected = [...test.expectFail].sort();
    return { name: test.name, ok: JSON.stringify(failed) === JSON.stringify(expected), expected, failed };
  });

  const allPass = Object.fromEntries(JUDGE_CRITERIA.map(([key]) => [key, { pass: true, reason: "ok" }]));
  const judgeTests = [
    { name: "judge JSON with all criteria passing", text: JSON.stringify(allPass), expectFail: [], expectWarn: [] },
    { name: "judge JSON wrapped in prose still parses", text: `Here you go:\n${JSON.stringify(allPass)}\nDone.`, expectFail: [], expectWarn: [] },
    { name: "judge third-person opener fails", text: JSON.stringify({ ...allPass, second_person: { pass: false, reason: "talks about him" } }), expectFail: ["judge: second person"], expectWarn: [] },
    { name: "judge null answer is skipped", text: JSON.stringify({ ...allPass, about_person: { pass: null, reason: "no page" } }), expectFail: [], expectWarn: [] },
    { name: "judge missing criterion warns", text: JSON.stringify({ ...allPass, natural_tone: undefined }), expectFail: [], expectWarn: ["judge: natural tone"] },
    { name: "judge non-JSON reply warns", text: "I think it looks fine.", expectFail: [], expectWarn: ["judge"] },
  ];
  for (const test of judgeTests) {
    const checks = parseJudgeResponse(test.text);
    const failed = checks.filter((check) => check.status === "fail").map((check) => check.name).sort();
    const warned = checks.filter((check) => check.status === "warn").map((check) => check.name).sort();
    const ok = JSON.stringify(failed) === JSON.stringify([...test.expectFail].sort())
      && JSON.stringify(warned) === JSON.stringify([...test.expectWarn].sort());
    results.push({ name: test.name, ok, expected: test.expectFail.concat(test.expectWarn.map((name) => `warn ${name}`)), failed: failed.concat(warned.map((name) => `warn ${name}`)) });
  }
  return { window, results, passed: results.filter((result) => result.ok).length, total: results.length };
}

function selfTest() {
  const { window, results, passed, total } = runSelfTests();
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok ? "" : `  (expected failures [${result.expected.join(", ")}], got [${result.failed.join(", ")}])`}`);
  }
  console.log(`\n${passed}/${total} self-tests passed (window ${window.start} to ${window.end})`);
  return passed === total;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    process.exit(selfTest() ? 0 : 1);
  }
  if (!process.env.EXA_API_KEY) {
    console.error("EXA_API_KEY is not set. Add it to .env and run `npm run eval`.");
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set. Eval cases are stored in MongoDB; add the connection string to .env.");
    process.exit(1);
  }

  const cases = await loadCases();
  if (!cases.length) {
    console.error("No eval cases in MongoDB. Add some from the Evals tab.");
    process.exit(1);
  }
  assertCasesHaveExpectations(cases);
  const selected = options.ids.length ? cases.filter((caseDef) => options.ids.includes(caseDef.id)) : cases;
  const unknown = options.ids.filter((id) => !cases.some((caseDef) => caseDef.id === id));
  if (unknown.length) {
    console.error(`Unknown case id(s): ${unknown.join(", ")}. Available: ${cases.map((caseDef) => caseDef.id).join(", ")}`);
    process.exit(1);
  }
  const runs = selected.flatMap((caseDef) => Array.from({ length: options.repeat }, (_, index) => ({
    ...caseDef,
    id: options.repeat > 1 ? `${caseDef.id}#${index + 1}` : caseDef.id,
  })));

  const window = signalWindow();
  console.log(`Running ${runs.length} eval run(s) at ${options.effort} effort, ${options.concurrency} at a time${options.judge ? `, graded by ${options.judgeModel}` : ""}. Signal window ${window.start} to ${window.end}.\n`);
  const results = await pool(runs, options.concurrency, async (caseDef) => {
    const result = await runCase(caseDef, options);
    printCase(result);
    return result;
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = `eval-results/${stamp}.json`;
  await mkdir("eval-results", { recursive: true });
  await writeFile(reportPath, JSON.stringify({ window, options, results }, null, 2));
  const summary = summarize(results);
  const { saveEvalRun, cleanRunName } = await import("./store.js");
  const name = cleanRunName(options.name);
  await saveEvalRun({
    name,
    source: "cli",
    effort: options.effort,
    judgeModel: options.judge ? options.judgeModel : null,
    sources: options.sources,
    passed: summary.passedCases,
    total: summary.totalCases,
    cost: summary.cost,
    summary: { ...summary, name, effort: options.effort, judgeModel: options.judge ? options.judgeModel : null, window },
    results,
  });
  printSummary(results, window, reportPath);
  process.exit(results.every((result) => result.passed) ? 0 : 1);
}

export { loadCases, validateCase, runCase, pool, summarize, runSelfTests, assertCasesHaveExpectations, judgeConfigured, limitsFor, GRADER_MODELS, DEFAULT_JUDGE_MODEL, JUDGE_CRITERIA, graderCost };

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
