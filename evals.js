import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { research, structuredFrom, groundingFrom, signalWindow, outputSchema } from "./index.js";

// expect: verdict, maxCostDollars, and maxLatencyMs are required on every case.
// role ("cro" or "vp_engineering") and personName are optional.
const CASES = [
  {
    id: "stripe",
    input: { accountName: "Stripe", domain: "stripe.com" },
    expect: { verdict: "ready", maxCostDollars: 0.05, maxLatencyMs: 60000 },
  },
  {
    id: "vercel-domain-only",
    input: { domain: "vercel.com" },
    expect: { verdict: "ready", maxCostDollars: 0.05, maxLatencyMs: 60000 },
  },
  {
    id: "datadog-cro-persona",
    input: { accountName: "Datadog", persona: "CRO" },
    expect: { verdict: "ready", role: "cro", maxCostDollars: 0.05, maxLatencyMs: 60000 },
  },
  {
    id: "snowflake-exclusion",
    input: { accountName: "Snowflake", exclusion: "Snowflake Summit" },
    expect: { verdict: "ready", maxCostDollars: 0.05, maxLatencyMs: 60000 },
  },
  {
    id: "unknown-company",
    input: { accountName: "Qzxvbn Robotics Holdings", domain: "qzxvbn-robotics.invalid" },
    expect: { verdict: "cannot_verify", maxCostDollars: 0.05, maxLatencyMs: 30000 },
  },
];

const EXPECTED_ROLES = {
  cro: /\bchief revenue officer\b|\bcro\b/i,
  vp_engineering: /\b(vp|svp|evp|vice president)\b[^;]*\bengineering\b/i,
};

const LAYOFF = /\b(lay-?offs?|laid off|job cuts|workforce reduction|reduction in force|downsizing)\b/i;
const ROLE = /\b(vp|svp|evp|vice president)\b[^;]*\bengineering\b|\bchief revenue officer\b|\bcro\b/i;

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
      : fail("role", `title "${person_title ?? "null"}" is not VP of Engineering or CRO`));
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
    checks.push(verdict === expect.verdict
      ? pass("expected verdict", verdict)
      : fail("expected verdict", `expected ${expect.verdict}, got ${verdict}`));
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

async function checkSource(output) {
  const url = output?.source_url;
  if (!url || !isHttpUrl(url)) return skip("source page", "no source_url");
  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" },
    });
  } catch (error) {
    return warn("source page", `could not fetch: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404 || response.status === 410) return fail("source page", `${url} returned ${response.status}`);
  if (!response.ok) return warn("source page", `${url} returned ${response.status} (likely blocks bots)`);
  const page = (await response.text()).toLowerCase();
  const lastName = String(output.person_name ?? "").trim().split(/\s+/).pop()?.toLowerCase();
  if (lastName && !page.includes(lastName)) return warn("source page", `page loaded but does not mention "${lastName}" (may be rendered by JavaScript)`);
  return pass("source page", `${response.status}${lastName ? `, mentions "${lastName}"` : ""}`);
}

async function runCase(caseDef, options) {
  const started = Date.now();
  try {
    const { run, window } = await research(caseDef.input, {
      quiet: true,
      signal: options.signal,
      log: options.log ?? (options.verbose ? undefined : () => {}),
    });
    const latencyMs = Date.now() - started;
    const reportedCost = run.costDollars?.total;
    const output = structuredFrom(run);
    const grounding = groundingFrom(run);
    const checks = checkOutput(output, { window, input: caseDef.input, expect: caseDef.expect, grounding });
    checks.push(...checkBudget({ cost: reportedCost, latencyMs }, caseDef.expect));
    checks.push(options.sources ? await checkSource(output) : skip("source page", "--no-sources"));
    return {
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
  return {
    passedCases: results.filter((result) => result.passed).length,
    totalCases: results.length,
    cost: results.reduce((sum, result) => sum + result.cost, 0),
    checkTotals,
  };
}

function printSummary(results, window, reportPath) {
  const { checkTotals, passedCases, cost } = summarize(results);
  console.log(`Signal window: ${window.start} to ${window.end}`);
  console.log(`Cases passed: ${passedCases}/${results.length}`);
  for (const [name, totals] of Object.entries(checkTotals)) {
    const counted = totals.pass + totals.fail + totals.warn;
    console.log(`  ${name.padEnd(17)} ${totals.pass}/${counted} pass${totals.fail ? `, ${totals.fail} fail` : ""}${totals.warn ? `, ${totals.warn} warn` : ""}`);
  }
  console.log(`Total cost: $${cost.toFixed(4)}`);
  if (reportPath) console.log(`Report: ${reportPath}`);
}

function parseArgs(argv) {
  const options = { ids: [], concurrency: 2, repeat: 1, sources: true, verbose: false, selfTest: false };
  for (const arg of argv) {
    if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--no-sources") options.sources = false;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg.startsWith("--concurrency=")) options.concurrency = Math.max(1, Number(arg.split("=")[1]) || 1);
    else if (arg.startsWith("--repeat=")) options.repeat = Math.max(1, Number(arg.split("=")[1]) || 1);
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
    { name: "wrong role fails", output: { ...ready, person_title: "CTO" }, grounding: cited, expectFail: ["role"] },
    { name: "CRO title passes", output: { ...ready, person_title: "Chief Revenue Officer" }, grounding: cited, expectFail: [] },
    { name: "expected verdict mismatch fails", expect: { verdict: "cannot_verify" }, output: ready, grounding: cited, expectFail: ["expected verdict"] },
    { name: "expected CRO but got VP of Engineering fails", expect: { role: "cro" }, output: ready, grounding: cited, expectFail: ["expected role"] },
    { name: "expected VP of Engineering passes", expect: { role: "vp_engineering" }, output: ready, grounding: cited, expectFail: [] },
    { name: "expected person matches", expect: { personName: "Lovelace" }, output: ready, grounding: cited, expectFail: [] },
    { name: "expected person mismatch fails", expect: { personName: "Grace Hopper" }, output: ready, grounding: cited, expectFail: ["expected person"] },
    { name: "cost and latency within limits pass", budget: { cost: 0.025, latencyMs: 20000 }, expect: { maxCostDollars: 0.05, maxLatencyMs: 60000 }, output: ready, grounding: cited, expectFail: [] },
    { name: "cost over limit fails", budget: { cost: 0.08, latencyMs: 20000 }, expect: { maxCostDollars: 0.05, maxLatencyMs: 60000 }, output: ready, grounding: cited, expectFail: ["cost"] },
    { name: "latency over limit fails", budget: { cost: 0.025, latencyMs: 61000 }, expect: { maxCostDollars: 0.05, maxLatencyMs: 60000 }, output: ready, grounding: cited, expectFail: ["latency"] },
  ];
  const results = tests.map((test) => {
    const checks = checkOutput(test.output, { window, input: test.input, expect: test.expect, grounding: test.grounding ?? [] });
    if (test.budget) checks.push(...checkBudget(test.budget, test.expect));
    const failed = checks.filter((check) => check.status === "fail").map((check) => check.name).sort();
    const expected = [...test.expectFail].sort();
    return { name: test.name, ok: JSON.stringify(failed) === JSON.stringify(expected), expected, failed };
  });
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
  assertCasesHaveExpectations(CASES);
  if (options.selfTest) {
    process.exit(selfTest() ? 0 : 1);
  }
  if (!process.env.EXA_API_KEY) {
    console.error("EXA_API_KEY is not set. Add it to .env and run `npm run eval`.");
    process.exit(1);
  }

  const selected = options.ids.length ? CASES.filter((caseDef) => options.ids.includes(caseDef.id)) : CASES;
  const unknown = options.ids.filter((id) => !CASES.some((caseDef) => caseDef.id === id));
  if (unknown.length) {
    console.error(`Unknown case id(s): ${unknown.join(", ")}. Available: ${CASES.map((caseDef) => caseDef.id).join(", ")}`);
    process.exit(1);
  }
  const runs = selected.flatMap((caseDef) => Array.from({ length: options.repeat }, (_, index) => ({
    ...caseDef,
    id: options.repeat > 1 ? `${caseDef.id}#${index + 1}` : caseDef.id,
  })));

  const window = signalWindow();
  console.log(`Running ${runs.length} eval run(s), ${options.concurrency} at a time. Signal window ${window.start} to ${window.end}.\n`);
  const results = await pool(runs, options.concurrency, async (caseDef) => {
    const result = await runCase(caseDef, options);
    printCase(result);
    return result;
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = `eval-results/${stamp}.json`;
  await mkdir("eval-results", { recursive: true });
  await writeFile(reportPath, JSON.stringify({ window, options, results }, null, 2));
  printSummary(results, window, reportPath);
  process.exit(results.every((result) => result.passed) ? 0 : 1);
}

export { CASES, runCase, pool, summarize, runSelfTests, assertCasesHaveExpectations };

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
