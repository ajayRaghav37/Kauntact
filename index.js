import { flushApiLogs, withApiContext, withApiContextDefaults } from "./apiLog.js";
import express from "express";
import Exa from "exa-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as store from "./store.js";
import { scoutClientJs } from "./scoutClient.js";

const PORT = Number(process.env.PORT) || 3000;

function isoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function signalWindow(now = new Date()) {
  const lastDayOfPreviousMonth = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), lastDayOfPreviousMonth));
  return { start: isoDate(start), end: isoDate(now) };
}

// Fixed efforts use Exa's published per-run price. Auto and ultra are metered, so Kauntact caps them with budgetDollars.
// Vercel cuts functions off at 300s, so hosted runs stop at 285s and the Exa run is cancelled.
const EFFORT_OPTIONS = [
  { id: "auto", label: "Auto", price: null, budgetDollars: 1, timeoutMs: 280000 },
  { id: "minimal", label: "Minimal", price: 0.012, timeoutMs: 180000 },
  { id: "low", label: "Low", price: 0.025, timeoutMs: 180000 },
  { id: "medium", label: "Medium", price: 0.1, timeoutMs: 180000 },
  { id: "high", label: "High", price: 0.5, timeoutMs: 240000 },
  { id: "xhigh", label: "Xhigh", price: 1, timeoutMs: 280000 },
  { id: "ultra", label: "Ultra", price: null, budgetDollars: 5, maxDurationSeconds: 300, timeoutMs: 420000 },
];
const EFFORTS = EFFORT_OPTIONS.map((option) => option.id);
const EMAIL_ENRICHMENT_PRICE = 0.02;
const HOSTED_TIMEOUT_MS = 285000;

function effortOption(effort) {
  return EFFORT_OPTIONS.find((option) => option.id === effort) ?? EFFORT_OPTIONS.find((option) => option.id === "low");
}

function timeoutFor(effort) {
  const { timeoutMs } = effortOption(effort);
  return process.env.VERCEL ? Math.min(timeoutMs, HOSTED_TIMEOUT_MS) : timeoutMs;
}

function maxCostFor(effort) {
  const option = effortOption(effort);
  return option.price ?? option.budgetDollars;
}

function buildSystemPrompt({ start, end }, { findEmail = false } = {}) {
  let prompt = `Today is ${end}. A signal is usable only when the page states a calendar date between ${start} and ${end}, inclusive. If the page has no year, drop the signal. signal_date is the day the person published the post, gave the talk, or the company announced the funding, never the date a talk was announced or scheduled. Allowed signals are a post the person wrote on linkedin or X (twitter), a talk the person gave, or a funding announcement by the company. An X post counts only from an account that is clearly the person's, such as one whose bio names the company or that their linkedin or company page links to; never use a parody or fan account. A comment, reply, reaction, repost, or quote post of someone else's post does not count. A company blog recap, news article, newsletter, or sponsored interview about the person does not count. A talk counts only when the page shows it took place, such as a recording, a transcript, or the person's own post about giving it; an agenda, speaker list, or company post promoting an upcoming session does not count. Describe the person's part exactly as the source does (panelist, speaker, host), never upgraded to keynote or led. Never use a layoff. person_title must be a leadership position in the company, such as VP of Engineering (including SVP or EVP of Engineering), Chief Revenue Officer, CTO, VP of Technology, or Chief Commercial Officer. A non-leadership role means cannot_verify. When a persona is given, the person must hold that role; if no one in that role has a usable signal, set verdict to cannot_verify instead of picking another leader. When a person name is given, research only that person; if they do not hold a leadership position at the company, set verdict to cannot_verify instead of picking someone else. Never invent a name, date, or URL. Write opener only when person_name, signal_date, and source_url are all present. Otherwise set opener to null and verdict to cannot_verify. opener is under 25 words, spoken to the person in the second person (you, your), said the way a sales rep would say it: plain and specific, with no compliments or hype words such as exciting, impressive, congrats, or momentum, and no claims beyond the signal. When the opener names a specific from the source, use the source's own words for it; do not substitute or add terms. Write subject only when opener is written: an email subject line under 8 words that references the signal, otherwise null. When a second CLI arg is present, do not use a signal about that event.`;
  if (findEmail) {
    prompt += " Set person_email only to an address for that person shown on a public page, or built from the company's email format when a public page confirms that format. Otherwise set person_email to null. Never guess an email.";
  }
  return prompt;
}

function schemaFor({ findEmail = false } = {}) {
  if (!findEmail) return outputSchema;
  return {
    ...outputSchema,
    properties: { ...outputSchema.properties, person_email: { type: ["string", "null"], format: "email" } },
  };
}

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["company", "verdict"],
  properties: {
    company: { type: "string" },
    person_name: { type: ["string", "null"] },
    person_title: { type: ["string", "null"] },
    signal: { type: ["string", "null"] },
    signal_date: { type: ["string", "null"], format: "date" },
    source_url: { type: ["string", "null"], format: "uri" },
    opener: { type: ["string", "null"], maxLength: 180 },
    subject: { type: ["string", "null"], maxLength: 80 },
    verdict: { type: "string", enum: ["ready", "cannot_verify"] },
  },
};

let requestCounter = 0;

function createLogger(scope, sink) {
  const startedAt = Date.now();
  return function log(level, message, details) {
    const entry = {
      time: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      source: "server",
      scope,
      level,
      message,
      details: details === undefined ? undefined : details,
    };
    const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
    console.error(`[${entry.time}] [${scope}] [${level}] +${entry.elapsedMs}ms ${message}${suffix}`);
    if (sink) sink(entry);
  };
}

function errorDetails(error) {
  if (!(error instanceof Error)) return { value: String(error) };
  return {
    name: error.name,
    message: error.message,
    statusCode: error.statusCode,
    cause: error.cause instanceof Error ? error.cause.message : error.cause,
    stack: error.stack?.split("\n").slice(0, 4).join("\n"),
  };
}

function eventSummary(event) {
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const summary = { id: event?.id };
  if (typeof data.status === "string") summary.status = data.status;
  if (typeof data.callId === "string") summary.callId = data.callId;
  if (typeof data.tool === "string") summary.tool = data.tool;
  if (typeof data.text === "string") summary.text = data.text.slice(0, 160);
  if (data.source && typeof data.source.url === "string") summary.url = data.source.url;
  if (data.item && typeof data.item.name === "string") summary.item = data.item.name;
  if (data.error) summary.error = data.error;
  if (data.costDollars) summary.costDollars = data.costDollars;
  return summary;
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function companyFrom(accountName, domain) {
  if (!accountName && !domain) {
    const error = new Error("At least one of account name or domain must be provided.");
    error.statusCode = 400;
    throw error;
  }
  return accountName || domain;
}

function buildQuery({ company, accountName, domain, persona, personName, exclusion, findEmail }) {
  const target = persona ? `the ${persona} (only someone in that role)` : "the VP of Engineering or the CRO";
  let query = `Find ${target} at ${company} and one recent public signal about that person, such as a linkedin or X post, a talk, or a funding announcement.`;
  if (accountName && domain) query += ` Domain: ${domain}.`;
  if (persona) query += ` Persona: ${persona}.`;
  if (personName) query += ` Person name: ${personName}.`;
  if (exclusion) query += ` Second CLI arg: ${exclusion}.`;
  if (findEmail) query += " Also find that person's work email address.";
  return query;
}

function readFields(input) {
  const accountName = clean(input.accountName);
  const domain = clean(input.domain);
  const persona = clean(input.persona);
  const personName = clean(input.personName);
  const exclusion = clean(input.exclusion);
  const company = companyFrom(accountName, domain);
  const effort = clean(input.effort) || "low";
  if (!EFFORTS.includes(effort)) {
    const error = new Error(`Effort must be one of: ${EFFORTS.join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }
  const findEmail = input.findEmail === true;
  return { accountName, domain, persona, personName, exclusion, company, effort, findEmail };
}

function noteTrace(traces, event) {
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  if (event.event === "agent_run.search_trace") {
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text) return null;
    const callId = typeof data.callId === "string" && data.callId ? data.callId : "";
    const tool = typeof data.tool === "string" ? data.tool : "";
    const key = callId || `trace-${traces.size + 1}`;
    const current = traces.get(key) || { callId: key, tool: "", text: "", urls: [] };
    current.text = text;
    if (tool) current.tool = tool;
    traces.set(key, current);
    return { ...current, urls: current.urls.slice() };
  }
  if (event.event === "agent_run.source.added") {
    const source = data.source && typeof data.source === "object" ? data.source : {};
    const url = typeof source.url === "string" ? source.url : "";
    if (!url) return null;
    const callId = typeof source.callId === "string" && source.callId
      ? source.callId
      : (typeof source.parentCallId === "string" ? source.parentCallId : "");
    const key = callId || "sources";
    const current = traces.get(key) || { callId: key, tool: "", text: "", urls: [] };
    if (!current.urls.includes(url)) current.urls.push(url);
    traces.set(key, current);
    return { ...current, urls: current.urls.slice() };
  }
  return null;
}

function failureMessage(event) {
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const info = data.error && typeof data.error === "object" ? data.error : {};
  return typeof info.message === "string" && info.message ? info.message : "The agent run failed.";
}

const RESEARCH_LOGGED = Symbol("research-logged");

async function research(input, options = {}) {
  if (!options[RESEARCH_LOGGED]) {
    return withApiContextDefaults({ surface: "research", purpose: "agent" }, () => research(input, { ...options, [RESEARCH_LOGGED]: true }));
  }
  const { onTrace, onStatus, signal, log = createLogger("cli"), quiet = false } = options;
  const fields = readFields(input);
  const query = buildQuery(fields);
  const window = signalWindow();
  log("info", "Built agent query", { company: fields.company, query, signalWindow: window });
  const agentInput = {
    data: [
      {
        company: fields.company,
        accountName: fields.accountName,
        domain: fields.domain,
        persona: fields.persona,
        personName: fields.personName,
      },
    ],
  };
  if (fields.exclusion) {
    agentInput.exclusion = [{ event: fields.exclusion }];
  }

  const exa = new Exa();
  const timeoutMs = timeoutFor(fields.effort);
  const timeoutSignal = signal ?? AbortSignal.timeout(timeoutMs);
  const option = effortOption(fields.effort);
  const budget = option.budgetDollars
    ? { maxCostDollars: option.budgetDollars, ...(option.maxDurationSeconds ? { maxDurationSeconds: option.maxDurationSeconds } : {}) }
    : undefined;
  log("info", "Creating Exa agent run (stream: true)", {
    effort: fields.effort,
    budget,
    findEmail: fields.findEmail,
    input: agentInput,
    timeoutMs,
  });

  const traces = new Map();
  const printed = new Map();
  const eventCounts = {};
  let run = null;
  let runId = null;
  try {
    const events = await exa.agent.runs.create(
      {
        query,
        systemPrompt: buildSystemPrompt(window, fields),
        effort: fields.effort,
        ...(budget ? { budget } : {}),
        outputSchema: schemaFor(fields),
        input: agentInput,
        stream: true,
      },
      { signal: timeoutSignal }
    );
    log("info", "Exa event stream opened");

    for await (const event of events) {
      if (!runId && typeof event.data?.id === "string") runId = event.data.id;
      eventCounts[event.event] = (eventCounts[event.event] || 0) + 1;
      log("debug", `Exa event: ${event.event}`, eventSummary(event));
      const trace = noteTrace(traces, event);
      if (!quiet && trace?.text && printed.get(trace.callId) !== trace.text) {
        printed.set(trace.callId, trace.text);
        console.log(`SEARCH TRACE: ${trace.tool ? `${trace.tool} — ` : ""}${trace.text}`);
      }
      if (trace && onTrace) onTrace(trace);
      if (event.event === "agent_run.created") onStatus?.("Run queued.");
      if (event.event === "agent_run.started") onStatus?.("The agent is searching…");
      if (event.event === "agent_run.completed") run = event.data;
      if (event.event === "agent_run.failed") throw new Error(failureMessage(event));
      if (event.event === "agent_run.cancelled") throw new Error("The agent run was cancelled.");
    }
    log("info", "Exa event stream closed", { eventCounts });
  } catch (error) {
    log("error", "Exa agent run threw", { ...errorDetails(error), eventCounts });
    if (runId && timeoutSignal.aborted) {
      try {
        await exa.agent.runs.cancel(runId);
        log("warn", "Cancelled the Exa run so it stops billing", { runId });
      } catch (cancelError) {
        log("warn", "Could not cancel the Exa run", { runId, ...errorDetails(cancelError) });
      }
    }
    if (!signal && (error?.name === "AbortError" || error?.name === "TimeoutError")) {
      await flushApiLogs();
      throw new Error(`Polling timeout: the agent run did not complete within ${timeoutMs}ms`);
    }
    await flushApiLogs();
    throw error;
  }

  if (!run) {
    log("error", "Stream ended without agent_run.completed", { eventCounts });
    await flushApiLogs();
    throw new Error("The agent run ended before it completed.");
  }
  log("info", "Agent run completed", {
    runId: run.id,
    status: run.status,
    stopReason: run.stopReason,
    costDollars: run.costDollars,
    hasStructured: Boolean(run.output?.structured),
    groundingCount: Array.isArray(run.output?.grounding) ? run.output.grounding.length : 0,
  });
  await flushApiLogs();
  return { run, fields, window };
}

function structuredFrom(run) {
  const structured = run?.output?.structured;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured;
  }
  if (typeof run?.output?.text === "string") {
    try {
      const parsed = JSON.parse(run.output.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

function groundingFrom(run) {
  const entries = run?.output?.grounding;
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => ({
    field: entry?.field ?? "",
    confidence: entry?.confidence ?? null,
    urls: Array.isArray(entry?.citations)
      ? entry.citations.map((citation) => citation?.url).filter((url) => typeof url === "string" && url)
      : [],
  }));
}

function show(value) {
  if (value === null || value === undefined || value === "") return "null";
  return String(value);
}

function printSuccess(run) {
  const result = structuredFrom(run);
  console.log(`OPENER: ${show(result.opener)}`);
  console.log(`PERSON: ${show(result.person_name)}`);
  console.log(`DATE: ${show(result.signal_date)}`);
  console.log(`URL: ${show(result.source_url)}`);
  console.log(`VERDICT: ${show(result.verdict)}`);
  console.log(`costDollars.total: ${show(run?.costDollars?.total)}`);
  for (const entry of groundingFrom(run)) {
    console.log(`field: ${show(entry.field)} confidence: ${show(entry.confidence)} urls: ${entry.urls.join(" ")}`);
  }
}

function writeSse(res, event, data) {
  try {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  } catch {
    // The browser is gone. Keep saving the run.
  }
}

function printError(error) {
  if (error instanceof Error) {
    console.log(error.message);
    return;
  }
  console.log(String(error));
}

function payloadFrom(run, fields) {
  const result = structuredFrom(run);
  return {
    company: result.company ?? fields.company,
    person_name: result.person_name ?? null,
    person_title: result.person_title ?? null,
    signal: result.signal ?? null,
    signal_date: result.signal_date ?? null,
    source_url: result.source_url ?? null,
    opener: result.opener ?? null,
    subject: result.subject ?? null,
    person_email: result.person_email ?? null,
    verdict: result.verdict ?? null,
    effort: fields.effort,
    costDollars: { total: run?.costDollars?.total ?? null },
    grounding: groundingFrom(run),
  };
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><mask id="crescent"><rect width="64" height="64" fill="#fff"/><circle cx="39" cy="25" r="14" fill="#000"/></mask></defs>
  <rect width="64" height="64" rx="15" fill="#1f40ed"/>
  <circle cx="29" cy="35" r="17" fill="#ffffff" mask="url(#crescent)"/>
  <path d="M46 10c.8 5.5 2.5 7.2 8 8-5.5.8-7.2 2.5-8 8-.8-5.5-2.5-7.2-8-8 5.5-.8 7.2-2.5 8-8z" fill="#ff5601"/>
</svg>`;

// Official marks from exa.ai/images/logo/exa-logo-blue.svg and tavily.com/icon.svg.
const BRAND_ICONS = {
  exa: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 107 129" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M106.417 9.30741C106.417 9.57392 106.324 9.83227 106.155 10.0388L61.5395 64.5L106.155 118.96C106.324 119.166 106.417 119.425 106.417 119.691V127.843C106.417 128.482 105.897 129 105.255 129H1.16175C0.520132 129 0 128.482 0 127.843V1.15695C0 0.517982 0.520131 0 1.16174 0H105.255C105.897 0 106.417 0.517984 106.417 1.15695V9.30741ZM19.0364 116.382H87.6921L53.363 74.4795L19.0364 116.382ZM12.6699 104.192L40.1426 70.6585H12.6699V104.192ZM12.6699 58.0409H39.8964L12.6699 24.8064V58.0409ZM53.363 54.5193L87.6921 12.6176H19.0364L53.363 54.5193Z" fill="#0143D9"/></svg>`,
  tavily: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 55 55" aria-hidden="true"><path d="M38.8088 0C44.4762 0 47.3101 9.1895e-05 49.4748 1.10306C51.3788 2.07326 52.927 3.62135 53.8971 5.52544C55.0001 7.69013 55 10.524 55 16.1914V38.8088C55 44.4761 55.0001 47.3099 53.8971 49.4746C52.927 51.3786 51.3788 52.9267 49.4748 53.8969C47.3101 54.9999 44.4762 55 38.8088 55H16.1914C10.5239 55 7.69014 54.9999 5.52544 53.8969C3.62133 52.9267 2.07325 51.3787 1.10306 49.4746C0.000109958 47.3099 0 44.4762 0 38.8088V16.1912C0 10.5238 0.000107614 7.69012 1.10306 5.52544C2.07325 3.62133 3.62133 2.07326 5.52544 1.10306C7.69014 8.88436e-05 10.5239 0 16.1914 0H38.8088Z" fill="#1F1E1E"/><path d="M23.3863 30.405C23.0885 30.405 22.7934 30.4638 22.5183 30.5782C22.2433 30.6926 21.9933 30.8603 21.7827 31.0716L17.4534 35.4188L16.3029 34.2638C15.4573 33.415 14.0099 33.8346 13.7471 35.0064L12.1073 42.3023C12.0498 42.5532 12.0568 42.8148 12.128 43.0621C12.199 43.3085 12.3313 43.5327 12.5123 43.7136L12.5108 43.7159C12.6915 43.8987 12.9155 44.0321 13.1619 44.1037C13.4083 44.1752 13.6688 44.1824 13.9188 44.1246L21.1862 42.4776C22.3527 42.2137 22.7715 40.7614 21.9259 39.9124L20.7754 38.7574L25.1056 34.411C25.5306 33.9842 25.7695 33.4049 25.7695 32.8013C25.7695 32.1977 25.5306 31.6185 25.1056 31.1916L25.0476 31.1334L25.0497 31.1319L24.9896 31.0716C24.7791 30.8603 24.529 30.6926 24.254 30.5782C23.979 30.4638 23.684 30.4051 23.3863 30.405Z M39.0054 27.6663C37.9941 27.0245 36.6768 27.7546 36.6766 28.9556V30.5884H27.3981C27.7081 31.1832 27.8847 31.8596 27.8847 32.5774C27.8846 33.6152 27.5181 34.5672 26.908 35.3099L36.6758 35.3096L36.6752 36.9424C36.6753 38.1434 37.9941 38.8736 39.0054 38.2319L45.3045 34.2387C45.7757 33.9384 46.0114 33.443 46.0115 32.948C46.0109 32.4536 45.7752 31.9592 45.303 31.6601L39.0054 27.6663Z M23.6104 10.2206C23.3539 10.2194 23.101 10.2839 22.8763 10.4081C22.6514 10.5325 22.4614 10.7132 22.3253 10.9318L18.3472 17.2549H18.3458C17.7067 18.2701 18.4346 19.5933 19.6307 19.5936H21.2578V28.9869C21.9327 28.5406 22.7403 28.2801 23.609 28.2801C24.4781 28.2801 25.2864 28.5407 25.9615 28.9875V19.5936H27.5884C28.7849 19.5936 29.5112 18.2702 28.8728 17.2541L24.8939 10.9318C24.5951 10.4584 24.1029 10.2212 23.6104 10.2206Z" fill="#FFFCF6"/></svg>`,
  llm: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#ff5601"/><path d="M12 4.5c.5 3.6 1.9 5 5.5 5.5-3.6.5-5 1.9-5.5 5.5-.5-3.6-1.9-5-5.5-5.5 3.6-.5 5-1.9 5.5-5.5z" fill="#fff"/><path d="M17.2 14.6c.2 1.5.8 2.1 2.3 2.3-1.5.2-2.1.8-2.3 2.3-.2-1.5-.8-2.1-2.3-2.3 1.5-.2 2.1-.8 2.3-2.3z" fill="#fff"/></svg>`,
};

function page() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Delulu AI Labs</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..500&family=Geist+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    :root {
      color-scheme: light;
      --ink: #1d1c1a;
      --muted: #5f5a54;
      --line: #e2dfda;
      --paper: #faf9f8;
      --card: #ffffff;
      --soft: #f2f1f0;
      --hover: #efedeb;
      --accent: #1f40ed;
      --accent-ink: #ffffff;
      --accent-soft: #ebeefe;
      --coral: #ff5601;
      --warn: #b42318;
      --warn-bg: #fdeceb;
      --serif: "Fraunces", "Iowan Old Style", Georgia, serif;
      --sans: "Inter", "Avenir Next", "Segoe UI", system-ui, sans-serif;
      --mono: "Geist Mono", ui-monospace, Menlo, Consolas, monospace;
      --shadow: 0 1px 2px rgba(29, 28, 26, 0.04), 0 1px 1px rgba(29, 28, 26, 0.02);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--paper);
      color: var(--ink);
      font: 15px/1.5 var(--sans);
      -webkit-font-smoothing: antialiased;
    }
    main {
      width: min(1200px, calc(100% - 40px));
      margin: 0 auto;
      padding: 28px 0 64px;
    }
    header.top { display: flex; align-items: center; gap: 16px; padding-bottom: 18px; }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .brand img { width: 40px; height: 40px; flex: none; }
    .brand-text { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    header h1 {
      margin: 0;
      font-family: var(--serif);
      font-size: 30px;
      font-weight: 400;
      letter-spacing: -0.025em;
      line-height: 1.1;
    }
    .motto { font-family: var(--serif); font-style: italic; font-weight: 300; font-size: 17px; color: var(--muted); }
    .account { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .usage { display: flex; align-items: stretch; }
    .usage-item { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-right: 1px solid var(--line); }
    .usage-item:last-child { border-right: 0; }
    .usage-item svg { width: 16px; height: 16px; flex: none; display: block; }
    .usage-item .usage-name { font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); line-height: 1.1; }
    .usage-item .usage-value { font-family: var(--mono); font-size: 13px; font-weight: 500; color: var(--ink); line-height: 1.2; font-variant-numeric: tabular-nums; }
    .usage-item.total { background: var(--soft); }
    .usage-stack { display: flex; flex-direction: column; }
    .usage-bar { display: flex; height: 3px; width: 100%; background: var(--soft); }
    .usage-bar span { display: block; height: 100%; transition: width 0.4s ease; }
    .usage-wrap { display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }
    .chip { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 6px 12px; font-size: 14px; font-weight: 650; cursor: default; }
    .chip small { display: block; font-size: 11px; font-weight: 400; color: var(--muted); }
    .chip.clickable { cursor: pointer; }
    .chip.clickable:hover, .chip.clickable:focus-visible { border-color: var(--accent); outline: none; }
    .chip.editing label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 400; color: var(--muted); }
    .chip.editing input { width: 120px; border: 1px solid var(--accent); border-radius: 8px; padding: 4px 8px; font: inherit; font-size: 14px; font-weight: 650; color: var(--ink); }
    .chip.user { display: flex; align-items: center; gap: 9px; border-radius: 999px; padding: 4px 14px 4px 4px; font-weight: 500; box-shadow: var(--shadow); }
    .avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: 0.04em; }
    .estimate { color: var(--muted); font-size: 13px; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 22px;
      box-shadow: var(--shadow);
    }
    .workspace { margin-top: 24px; display: grid; gap: 20px; }
    .workspace.idle { max-width: 680px; }
    .workspace.split { grid-template-columns: 340px minmax(0, 1fr); align-items: start; }
    .left { display: grid; gap: 20px; align-content: start; min-width: 0; }
    .history-card h2 { font-size: 16px; }
    .history-list { list-style: none; margin: 10px 0 0; padding: 0; max-height: 360px; overflow: auto; display: grid; gap: 2px; }
    button.history-item { width: 100%; background: transparent; color: var(--ink); border-radius: 10px; padding: 8px; font-weight: 400; text-align: left; gap: 10px; }
    button.history-item:hover, button.history-item:focus-visible { background: var(--hover); outline: none; }
    .history-label { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; }
    .history-kind { flex: none; width: 30px; height: 22px; border-radius: 6px; display: grid; place-items: center; font-size: 10px; font-weight: 700; background: var(--accent-soft); color: var(--accent); }
    .history-kind.batch { background: #fff1e8; color: #c2410c; }
    .tabs a .count, .count { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; margin-left: 6px; border-radius: 999px; background: var(--coral); color: #fff; font-size: 11px; font-weight: 700; vertical-align: 1px; }
    button.bell-button { background: transparent; color: var(--muted); padding: 3px; margin-left: 6px; border-radius: 6px; vertical-align: middle; }
    button.bell-button:hover, button.bell-button:focus-visible { background: var(--accent-soft); color: var(--accent); outline: none; }
    .person button.bell-button svg { width: 17px; height: 17px; }
    button.selection-bell { position: fixed; z-index: 40; width: 34px; height: 34px; padding: 0; justify-content: center; box-shadow: 0 6px 18px rgba(29, 28, 26, 0.22); }
    .alert-composer { position: fixed; z-index: 50; box-shadow: 0 16px 40px rgba(29, 28, 26, 0.22); display: grid; gap: 10px; padding: 16px; }
    .alert-composer h2 { font-size: 16px; display: flex; align-items: center; gap: 6px; }
    .alert-composer .actions { margin-top: 4px; }
    .alert-composer select, .alert-form select { padding: 9px 10px; border-radius: 10px; }
    .toast { position: fixed; z-index: 60; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--ink); color: #fff; padding: 10px 16px; border-radius: 12px; font-size: 14px; box-shadow: 0 10px 28px rgba(29, 28, 26, 0.3); }
    .alerts { margin-top: 24px; display: grid; gap: 20px; }
    .alert-form { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
    .alert-form input { flex: 1; min-width: 240px; }
    .alerts-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 20px; align-items: start; }
    .alert-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 4px; }
    .alert-list li { border-radius: 12px; padding: 10px; border: 1px solid transparent; }
    .alert-list li.selected { border-color: var(--accent); background: var(--paper); }
    button.alert-name { background: none; color: var(--ink); padding: 0; font-weight: 400; text-align: left; border-radius: 0; }
    .alert-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 8px; font-size: 13px; }
    .alert-actions select { font-size: 13px; }
    button.link.danger { color: var(--warn); }
    .news { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 4px; max-height: 720px; overflow: auto; }
    .news li { border-top: 1px solid var(--line); padding: 10px 0; }
    .news li p { margin: 4px 0 0; }
    .news-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
    .news-query { background: var(--soft); border-radius: 999px; padding: 0 8px; }
    .news-title { display: block; margin-top: 2px; font-weight: 650; text-decoration: none; color: var(--ink); }
    .news-title:hover { color: var(--accent); text-decoration: underline; }
    .news li.unread .news-title { color: var(--accent); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--coral); }
    .news-summary { margin: 12px 0 0; padding: 10px 12px; background: #fff; border: 1px solid var(--line); border-radius: 10px; font-size: 14px; white-space: pre-wrap; }
    .case-links { display: flex; gap: 10px; margin-top: 2px; font-size: 12px; }
    .case-add { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
    .case-editor { margin-top: 14px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
    .case-editor h3 { margin: 0 0 12px; }
    .case-editor .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .case-editor select { padding: 9px 10px; border-radius: 10px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
    .workspace.split .grid { grid-template-columns: 1fr; gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field.wide { grid-column: 1 / -1; }
    label span, .label { font-size: 13px; font-weight: 650; }
    input[type=text], textarea {
      width: 100%;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      border-radius: 10px;
      padding: 10px 12px;
      font: inherit;
    }
    textarea { min-height: 72px; resize: vertical; }
    .effort-picker { position: relative; min-width: 240px; }
    button.effort-button { width: 100%; background: #fff; color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font-weight: 600; gap: 10px; }
    button.effort-button .muted { margin-left: auto; font-weight: 400; font-size: 14px; }
    button.effort-button .caret { color: var(--muted); font-size: 12px; }
    button.effort-button:disabled { cursor: not-allowed; }
    .effort-menu { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; right: 0; margin: 0; padding: 6px; list-style: none; background: #fff; border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 28px rgba(29, 28, 26, 0.14); }
    .effort-menu li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; }
    .effort-menu li .muted { font-weight: 400; }
    .effort-menu li:hover, .effort-menu li:focus-visible { background: var(--hover); outline: none; }
    .effort-menu li.selected { background: var(--accent-soft); color: var(--accent); }
    .model-picker { display: grid; gap: 6px; min-width: min(320px, 100%); flex: 1 1 280px; }
    .eval-options .model-picker { max-width: 420px; }
    button.model-trigger { width: 100%; justify-content: space-between; background: #fff; color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font-weight: 600; text-align: left; gap: 12px; }
    button.model-trigger:disabled { cursor: not-allowed; opacity: 0.65; }
    button.model-trigger .model-trigger-main { display: grid; gap: 2px; min-width: 0; }
    button.model-trigger .model-trigger-meta { font-weight: 400; font-size: 12px; color: var(--muted); }
    button.model-trigger .caret { color: var(--muted); font-size: 12px; flex: 0 0 auto; }
    .model-dialog-backdrop { position: fixed; inset: 0; z-index: 80; background: rgba(29, 28, 26, 0.38); display: flex; align-items: center; justify-content: center; padding: 24px; }
    .model-dialog { width: min(760px, 100%); max-height: min(82vh, 720px); background: #fff; border-radius: 18px; border: 1px solid var(--line); box-shadow: 0 24px 60px rgba(29, 28, 26, 0.28); display: grid; grid-template-rows: auto auto 1fr; overflow: hidden; }
    .model-dialog-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; padding: 18px 18px 12px; border-bottom: 1px solid var(--line); }
    .model-dialog-head h3 { margin: 0; font-size: 18px; }
    .model-dialog-tools { display: grid; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--paper); }
    .model-dialog-tools input[type=search] { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); font: inherit; }
    .model-dialog-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .model-dialog-filters select { padding: 7px 10px; border-radius: 10px; border: 1px solid var(--line); font: inherit; background: #fff; }
    .model-dialog-filters .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .model-dialog-filters button.chip { padding: 6px 10px; border-radius: 999px; border: 1px solid var(--line); background: #fff; color: var(--ink); font-size: 12px; font-weight: 600; }
    .model-dialog-filters button.chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
    .model-dialog-list { overflow: auto; padding: 8px; display: grid; gap: 4px; align-content: start; }
    .model-dialog-group { margin: 10px 8px 4px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
    button.model-option { width: 100%; justify-content: space-between; gap: 12px; text-align: left; background: transparent; border: 0; border-radius: 12px; padding: 10px 12px; color: var(--ink); font-weight: 600; }
    button.model-option:hover, button.model-option:focus-visible { background: var(--hover); outline: none; }
    button.model-option.selected { background: var(--accent-soft); color: var(--accent); }
    button.model-option .model-option-main { display: grid; gap: 2px; min-width: 0; }
    button.model-option .model-option-id { font-weight: 400; font-size: 12px; color: var(--muted); }
    button.model-option .model-option-price { font-weight: 400; font-size: 12px; color: var(--muted); white-space: nowrap; }
    .model-dialog-empty { padding: 28px 12px; text-align: center; color: var(--muted); }
    .eval-effort { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
    .eval-effort .effort-picker { width: 280px; }
    .warning { margin: 12px 0 0; background: #fff7e6; color: #8a5a00; border-radius: 10px; padding: 10px 12px; font-size: 13px; }
    .head-actions { display: flex; gap: 8px; }
    .table-scroll { overflow-x: auto; }
    table.compare th small { display: block; font-weight: 400; }
    table.compare tbody th { font-size: 13px; color: var(--ink); font-weight: 600; border-top: 1px solid var(--line); white-space: nowrap; padding-right: 16px; }
    table.compare td { font-size: 14px; min-width: 150px; }
    .compare-cell { display: flex; flex-direction: column; gap: 3px; align-items: flex-start; font-size: 13px; }
    h3 { margin: 22px 0 0; font-size: 15px; }
    .grader-expect { margin: 2px 0 0; padding-left: 16px; color: var(--muted); }
    .grader-expect li { cursor: help; }
    .side { display: grid; gap: 16px; min-width: 0; }
    .traces-card h2 { font-size: 16px; }
    .traces { list-style: none; margin: 12px 0 0; padding: 0 4px 0 0; height: 300px; overflow: auto; display: grid; align-content: start; gap: 8px; }
    .traces-card.live .traces { height: 420px; }
    .traces li { border: 1px solid var(--line); border-left: 3px solid var(--accent); background: #fff; border-radius: 10px; padding: 8px 12px; font-size: 14px; }
    .traces li.trace-empty { border: 1px dashed var(--line); background: transparent; color: var(--muted); }
    .trace-head { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
    .trace-tool { background: var(--accent-soft); color: var(--accent); border-radius: 999px; padding: 0 8px; font-weight: 650; }
    .trace-urls { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: 12px; }
    .mode-switch { display: inline-flex; background: var(--soft); border-radius: 999px; padding: 3px; margin-bottom: 16px; }
    .mode-switch button { background: transparent; color: var(--muted); padding: 6px 14px; font-size: 14px; }
    .mode-switch button.active { background: var(--card); color: var(--accent); box-shadow: 0 1px 3px rgba(29, 28, 26, 0.12); }
    .mode-switch button:disabled { cursor: not-allowed; }
    .csv-input input[type=file] { font: inherit; font-size: 14px; }
    .csv-summary { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font-size: 14px; display: grid; gap: 4px; }
    .progress { height: 6px; background: var(--soft); border-radius: 999px; overflow: hidden; margin-top: 12px; }
    .progress span { display: block; height: 100%; background: var(--accent); transition: width 0.3s; }
    .batch-table { max-height: 560px; overflow: auto; }
    .batch-table td { font-size: 14px; }
    .batch-opener { min-width: 220px; }
    small.block { display: block; }
    td.grader-merged { border-left: 1px solid var(--line); padding-left: 14px; }
    .grader-expect-cell { position: sticky; top: 16px; display: flex; flex-direction: column; gap: 6px; }
    .check { flex-direction: row; align-items: flex-start; gap: 10px; cursor: pointer; }
    .check input { margin: 3px 0 0; accent-color: var(--accent); width: 16px; height: 16px; flex: none; }
    .check small { display: block; color: var(--warn); font-size: 12px; font-weight: 400; margin-top: 2px; }
    .hint { margin: 12px 0 0; color: var(--muted); font-size: 13px; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
    .run-name { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--muted); }
    .run-name input { font: inherit; color: var(--ink); width: 240px; padding: 8px 12px; border-radius: 999px; border: 1px solid var(--line); background: #fff; }
    .run-title { margin: 0 0 12px; font-size: 16px; }
    .run-rename { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .run-rename input { font: inherit; font-size: 14px; color: var(--ink); width: 240px; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--line); background: #fff; }
    button, .button {
      appearance: none;
      border: 1px solid transparent;
      background: var(--accent);
      color: var(--accent-ink);
      border-radius: 8px;
      padding: 9px 16px;
      font: inherit;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    button:not([class]):hover:not(:disabled), button.primary:hover:not(:disabled), a.button:not(.ghost):hover { background: #1633c9; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .button.ghost, button.ghost { background: var(--card); color: var(--ink); border: 1px solid var(--line); }
    .button.ghost:hover, button.ghost:hover:not(:disabled) { background: var(--hover); border-color: #d3cfc8; }
    .button.disabled { opacity: 0.45; pointer-events: none; }
    .error {
      margin-top: 14px;
      background: var(--warn-bg);
      color: var(--warn);
      border-radius: 10px;
      padding: 10px 12px;
    }
    a { color: var(--accent); }
    h2 { margin: 0; font-family: var(--serif); font-weight: 400; font-size: 21px; letter-spacing: -0.015em; }
    input[type=text]:focus, input[type=search]:focus, input[type=number]:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .result-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .company { color: var(--muted); font-size: 13px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em; }
    .person { margin: 4px 0 0; font-family: var(--serif); font-weight: 400; font-size: 28px; line-height: 1.15; }
    .title { color: var(--muted); margin-top: 2px; }
    .email { margin-top: 6px; font-size: 14px; }
    .badge { flex: none; font-size: 12px; font-weight: 700; border-radius: 999px; padding: 4px 10px; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge.ready { background: var(--accent-soft); color: var(--accent); }
    .badge.cannot_verify { background: var(--warn-bg); color: var(--warn); }
    .opener { margin: 18px 0 0; padding: 14px 16px; border-left: 4px solid var(--coral); background: #fff; border-radius: 0 12px 12px 0; font-size: 18px; }
    .subject { margin-top: 10px; font-size: 14px; color: var(--muted); }
    .subject b { color: var(--ink); font-weight: 650; }
    .signal { margin-top: 18px; display: grid; grid-template-columns: 90px 1fr; gap: 6px 12px; font-size: 14px; }
    .signal dt { color: var(--muted); }
    .signal dd { margin: 0; word-break: break-word; }
    .result-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 18px; }
    .cost { margin-left: auto; color: var(--muted); font-size: 13px; }
    .muted { color: var(--muted); }
    details.grounding { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 12px; font-size: 14px; }
    details.grounding summary { cursor: pointer; color: var(--muted); font-weight: 650; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { text-align: left; padding: 6px 8px 6px 0; border-top: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-family: var(--mono); font-weight: 400; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; border-top: 0; }
    table.compare tbody th, .scout-summary tbody th { font-family: var(--sans); text-transform: none; letter-spacing: 0; }
    .conf { font-size: 12px; font-weight: 650; border-radius: 999px; padding: 1px 8px; background: var(--soft); }
    .conf.high { background: var(--accent-soft); color: var(--accent); }
    .conf.low { background: var(--warn-bg); color: var(--warn); }
    td a { margin-right: 8px; }
    .pending { display: flex; align-items: center; gap: 12px; color: var(--muted); }
    .spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .panels { margin-top: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .panel-head button { padding: 5px 12px; font-size: 13px; }
    .logs {
      margin: 12px 0 0;
      padding: 12px;
      height: 300px;
      overflow: auto;
      background: #1d1c1a;
      color: #e9e4da;
      border-radius: 10px;
      font: 12px/1.6 var(--mono);
      list-style: none;
    }
    .logs li { white-space: pre-wrap; word-break: break-word; }
    .logs .empty { color: #8f877b; }
    .logs .server { color: #9db1ff; }
    .logs .warn { color: #f2c57c; }
    .logs .error { color: #f4a38a; }
    .logs .tool { color: #f2c57c; }
    .logs a { color: #9db1ff; display: block; padding-left: 2ch; }
    .tabs { display: flex; gap: 2px; margin-top: 4px; border-bottom: 1px solid var(--line); overflow-x: auto; }
    .tabs a { padding: 10px 14px; color: var(--muted); text-decoration: none; font-weight: 500; font-size: 14px; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; transition: color 0.15s; }
    .tabs a:hover { color: var(--ink); }
    .tabs a.active { color: var(--ink); border-bottom-color: var(--accent); }
    .evals { margin-top: 24px; display: grid; gap: 20px; }
    .small-text { font-size: 13px; }
    table.cases td, table.totals td { font-size: 14px; }
    table.cases td:first-child { width: 28px; }
    table.cases input { accent-color: var(--accent); width: 16px; height: 16px; }
    .eval-options { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 14px; font-size: 14px; }
    .inline-check { display: flex; align-items: center; gap: 8px; }
    .inline-check input { accent-color: var(--accent); }
    select { font: inherit; padding: 2px 6px; border-radius: 8px; border: 1px solid var(--line); background: #fff; }
    .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; border-radius: 999px; padding: 2px 10px; flex: none; }
    .pill.pass { background: var(--accent-soft); color: var(--accent); }
    .pill.fail { background: var(--warn-bg); color: var(--warn); }
    .pill.running { background: var(--soft); color: var(--muted); }
    .spinner.small { width: 10px; height: 10px; border-width: 2px; }
    .stats { display: flex; gap: 32px; flex-wrap: wrap; }
    .stats > div { display: flex; flex-direction: column; }
    .stat-label { font-family: var(--mono); font-size: 11px; color: var(--muted); font-weight: 400; text-transform: uppercase; letter-spacing: 0.06em; }
    .stat { font-family: var(--serif); font-weight: 400; font-size: 24px; }
    .stat.small { font-size: 16px; padding-top: 6px; }
    table.totals { max-width: 520px; margin-top: 16px; }
    .bad { color: var(--warn); font-weight: 700; }
    .meh { color: #a16207; font-weight: 700; }
    .eval-cases { list-style: none; margin: 16px 0 0; padding: 0; }
    .eval-case { border-top: 1px solid var(--line); padding: 10px 0; }
    .eval-row { display: flex; align-items: center; gap: 10px; cursor: pointer; flex-wrap: wrap; }
    .eval-summary { flex: 1; min-width: 200px; font-size: 14px; }
    .eval-meta { color: var(--muted); font-size: 13px; }
    .opener.small { font-size: 15px; margin: 10px 0 0; padding: 8px 12px; }
    .eval-source { font-size: 13px; margin-top: 6px; }
    .checks { list-style: none; margin: 10px 0 0; padding: 0; font-size: 13px; display: grid; gap: 4px; }
    .checks li { display: flex; gap: 10px; }
    .check-status { font: 500 11px/1.8 var(--mono); width: 38px; flex: none; }
    .check-status.pass { color: var(--accent); }
    .check-status.fail { color: var(--warn); }
    .check-status.warn { color: #a16207; }
    .history { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; font-size: 14px; }
    .history li { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    button.link { background: none; color: var(--accent); padding: 0; border-radius: 0; font-weight: 600; text-decoration: underline; }
    .panels.single { grid-template-columns: 1fr; }
    button.link.options-toggle { margin-top: 14px; font-size: 14px; }
    .scout-provider { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
    .scout-provider .mode-switch { margin-bottom: 0; }
    .scout-options { display: grid; gap: 12px; margin-top: 10px; }
    .scout-fieldset { border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px 14px; margin: 0; background: #fff; }
    .scout-fieldset legend { padding: 0 6px; font-size: 13px; font-weight: 700; color: var(--accent); }
    .scout-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px 14px; }
    .scout-fieldset select, .scout-fieldset input[type=number] { width: 100%; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); font: inherit; font-size: 14px; background: #fff; }
    .scout-compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; margin-top: 10px; }
    .scout-answer { min-width: 0; }
    .scout-stats { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 8px; font-size: 12px; color: var(--muted); }
    .lat { border-radius: 999px; padding: 0 8px; font-weight: 700; }
    .lat.ok { background: var(--accent-soft); color: var(--accent); }
    .lat.slow { background: var(--warn-bg); color: var(--warn); }
    .scout-text { margin-top: 12px; font-size: 15px; }
    .scout-text p { margin: 0 0 8px; }
    a.cite, span.cite { display: inline-block; min-width: 16px; margin: 0 1px; padding: 0 4px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); font-size: 11px; font-weight: 700; text-align: center; text-decoration: none; vertical-align: 2px; line-height: 16px; }
    span.cite.missing { background: var(--warn-bg); color: var(--warn); }
    .scout-sources { margin: 8px 0 0; padding-left: 22px; font-size: 13px; display: grid; gap: 4px; word-break: break-word; }
    .grade-details { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--line); }
    .grade-details p { margin: 6px 0 0; }
    .grade-chip { display: inline-block; margin: 0 6px 4px 0; padding: 0 8px; border-radius: 999px; background: var(--soft); font-size: 12px; }
    .grade-chip.bad { background: var(--warn-bg); color: var(--warn); font-weight: 700; }
    .fact { margin-right: 10px; }
    .fact.hit { color: var(--accent); }
    .fact.miss { color: var(--warn); }
    td.winner { background: var(--accent-soft); color: var(--accent); font-weight: 650; }
    .eval-meta.winner { color: var(--accent); font-weight: 700; }
    .eval-case details > summary { list-style: none; }
    .eval-case details > summary::-webkit-details-marker { display: none; }
    .run-panel { margin-top: 18px; background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; display: grid; gap: 14px; }
    .run-panel .eval-options, .run-panel .eval-effort { margin-top: 0; align-items: center; }
    .run-panel .warning, .run-panel .hint, .run-panel > p { margin: 0; }
    .run-panel button.link.options-toggle { margin-top: 0; justify-self: start; }
    .run-panel .scout-options { margin-top: 0; }
    .run-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 14px; border-top: 1px solid var(--line); }
    .run-bar .run-name input { width: 260px; border-radius: 8px; }
    .run-bar .estimate { margin-left: auto; font-family: var(--mono); font-size: 12px; }
    .run-panel .eval-label { font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
    .section-label { margin: 22px 0 10px; font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
    .case-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    .case-search { position: relative; flex: 1 1 280px; max-width: 420px; }
    .case-search svg { position: absolute; left: 11px; top: 50%; width: 15px; height: 15px; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
    .case-search input { width: 100%; padding: 8px 12px 8px 33px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); font: inherit; font-size: 14px; color: var(--ink); }
    .case-count { font-size: 13px; color: var(--muted); }
    .case-count b { color: var(--ink); font-weight: 600; }
    .case-toolbar button.small { margin-left: auto; padding: 6px 12px; font-size: 13px; }
    .evals > *, .workspace > *, .alerts > * { min-width: 0; }
    .case-scroll { max-height: 440px; max-width: 100%; overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
    table.cases td.nowrap { white-space: nowrap; }
    .case-scroll table.cases { margin: 0; }
    .case-scroll table.cases th, .case-scroll table.cases td { padding: 9px 12px; }
    .case-scroll table.cases thead th { position: sticky; top: 0; z-index: 2; background: var(--soft); border-bottom: 1px solid var(--line); }
    .case-scroll table.cases tbody tr:first-child td { border-top: 0; }
    .case-scroll table.cases tbody tr:hover td { background: var(--paper); }
    .case-scroll .select-col, table.cases td:first-child { width: 36px; }
    .case-scroll .empty-row td { text-align: center; padding: 28px 12px; color: var(--muted); }
    button.sort { background: none; border: 0; padding: 0; color: inherit; font: inherit; letter-spacing: inherit; text-transform: inherit; gap: 6px; border-radius: 0; }
    button.sort:hover, button.sort.active { color: var(--ink); background: none; }
    .sort-caret { font-size: 11px; opacity: 0.45; }
    button.sort.active .sort-caret { opacity: 1; color: var(--accent); }
    .grader-panel { font-size: 13px; }
    .grader-panel summary { cursor: pointer; color: var(--muted); font-weight: 500; }
    .grader-panel .grader-expect-cell { position: static; margin-top: 8px; }
    @media (max-width: 900px) {
      .scout-compare { grid-template-columns: 1fr; }
      .workspace.split, .panels, .alerts-grid { grid-template-columns: 1fr; }
      .case-editor .grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 760px) {
      header.top { flex-wrap: wrap; }
      .account { margin-left: 0; width: 100%; flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; }
      .usage-wrap { width: 100%; }
      .usage { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .usage-item { padding: 7px 8px; gap: 6px; }
      .panel-head { flex-wrap: wrap; }
    }
    @media (max-width: 600px) {
      .grid { grid-template-columns: 1fr; }
      header h1 { font-size: 26px; }
      .run-bar .run-name input { width: 100%; }
      .run-bar .estimate { margin-left: 0; }
      .signal { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main id="root"></main>
  <script src="/vendor/react.js"></script>
  <script src="/vendor/react-dom.js"></script>
  <script>
${clientJs()}
  </script>
</body>
</html>`;
}

function clientJs() {
  return `
const e = React.createElement;
const { useState, useRef, useEffect } = React;
const EFFORTS = ${JSON.stringify(EFFORTS)};
const EFFORT_OPTIONS = ${JSON.stringify(EFFORT_OPTIONS)};
const EMAIL_ENRICHMENT_PRICE = ${JSON.stringify(EMAIL_ENRICHMENT_PRICE)};
const BRAND_ICONS = ${JSON.stringify(BRAND_ICONS)};

function money(value, digits) {
  return "$" + Number(value).toFixed(digits === undefined ? 2 : digits);
}

function balanceMoney(value) {
  const cents = value * 100;
  return money(value, Math.abs(cents - Math.round(cents)) < 1e-6 ? 2 : 3);
}

function sessionMoney(value) {
  const amount = Number(value) || 0;
  if (amount >= 1) return money(amount, 2);
  if (amount >= 0.01) return money(amount, 3);
  return money(amount, 4);
}

function initialsOf(name) {
  const parts = String(name || "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const USAGE_ITEMS = [
  { key: "exa", label: "Exa", color: "#1f40ed" },
  { key: "tavily", label: "Tavily", color: "#1d1c1a" },
  { key: "llm", label: "LLM", color: "#ff5601" }
];

function Account(props) {
  const account = props.account;
  const cost = props.cost || { exa: 0, tavily: 0, llm: 0 };
  const name = (account && account.username) || "Local";
  const total = USAGE_ITEMS.reduce(function (sum, item) { return sum + (Number(cost[item.key]) || 0); }, 0);
  return e("div", { className: "account" },
    e("div", { className: "chip user", title: account && account.username ? "Signed in as " + account.username : "No sign-in (local)" },
      e("span", { className: "avatar", "aria-hidden": "true" }, initialsOf(name)),
      name
    ),
    e("div", { className: "usage-wrap", title: "API spend in this browser session. Reloading the page starts it over." },
      e("div", { className: "usage", role: "group", "aria-label": "API spend this session" },
        USAGE_ITEMS.map(function (item) {
          return e("div", { key: item.key, className: "usage-item" },
            e("span", { dangerouslySetInnerHTML: { __html: BRAND_ICONS[item.key] } }),
            e("div", { className: "usage-stack" },
              e("span", { className: "usage-name" }, item.label),
              e("span", { className: "usage-value" }, sessionMoney(cost[item.key]))
            )
          );
        }),
        e("div", { className: "usage-item total" },
          e("div", { className: "usage-stack" },
            e("span", { className: "usage-name" }, "Session"),
            e("span", { className: "usage-value" }, sessionMoney(total))
          )
        )
      ),
      e("div", { className: "usage-bar", "aria-hidden": "true" },
        total > 0 ? USAGE_ITEMS.map(function (item) {
          return e("span", { key: item.key, style: { width: ((Number(cost[item.key]) || 0) / total * 100) + "%", background: item.color } });
        }) : null
      )
    )
  );
}

function effortById(id) {
  return EFFORT_OPTIONS.find(function (option) { return option.id === id; }) || EFFORT_OPTIONS[2];
}

function effortPrice(option) {
  return option.price === null ? "Scales with task" : balanceMoney(option.price) + "/request";
}

function maxCostFor(id) {
  const option = effortById(id);
  return option.price === null ? option.budgetDollars : option.price;
}

function CostEstimate(props) {
  const option = effortById(props.effort);
  return e("span", { className: "estimate" },
    option.price === null
      ? "Cost scales with the task, capped at " + money(option.budgetDollars) + " (" + option.label + " effort)"
      : "Estimated cost ≈ " + balanceMoney(option.price) + " (" + option.label + " effort)",
    props.findEmail ? " + up to " + money(EMAIL_ENRICHMENT_PRICE) + " if the email lookup is billed" : ""
  );
}

function show(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function Field(props) {
  return e("label", { className: "field" + (props.wide ? " wide" : "") },
    e("span", null, props.label),
    e(props.multiline ? "textarea" : "input", {
      type: props.multiline ? undefined : "text",
      id: props.id,
      name: props.id,
      value: props.value,
      placeholder: props.placeholder || "",
      readOnly: props.readOnly,
      onChange: function (event) { props.onChange(event.target.value); }
    })
  );
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\\./, ""); } catch (err) { return url; }
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value + "T00:00:00");
  if (isNaN(date)) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function mailtoFor(result) {
  const params = [];
  if (result.subject) params.push("subject=" + encodeURIComponent(result.subject));
  if (result.opener) params.push("body=" + encodeURIComponent(result.opener));
  return "mailto:" + encodeURIComponent(result.person_email || "").replace(/%40/g, "@") + (params.length ? "?" + params.join("&") : "");
}

function Result(props) {
  const result = props.result;
  const grounding = result.grounding || [];
  const ready = result.verdict === "ready";
  const cost = result.costDollars && result.costDollars.total;
  return e("section", { className: "card" },
    e("div", { className: "result-head" },
      e("div", null,
        e("div", { className: "company" }, show(result.company),
          props.onAlert ? e(AlertButton, { query: result.company, onAlert: props.onAlert }) : null),
        e("h2", { className: "person" }, result.person_name || "No verified contact",
          props.onAlert && result.person_name ? e(AlertButton, { query: result.person_name + (result.company ? " " + result.company : ""), onAlert: props.onAlert }) : null),
        result.person_title ? e("div", { className: "title" }, result.person_title) : null,
        result.person_email
          ? e("div", { className: "email" }, e("a", { href: "mailto:" + result.person_email }, result.person_email))
          : null
      ),
      e("span", { className: "badge " + (result.verdict || "") }, ready ? "Ready" : "Cannot verify")
    ),
    result.opener
      ? e("blockquote", { className: "opener" }, result.opener)
      : e("p", { className: "muted" }, "No dated, verifiable signal was found in the last month, so no opener was written."),
    result.subject ? e("div", { className: "subject" }, "Subject: ", e("b", null, result.subject)) : null,
    result.signal || result.signal_date || result.source_url
      ? e("dl", { className: "signal" },
          e("dt", null, "Signal"), e("dd", null, show(result.signal)),
          e("dt", null, "Date"), e("dd", null, formatDate(result.signal_date)),
          e("dt", null, "Source"), e("dd", null, result.source_url
            ? e("a", { href: result.source_url, target: "_blank", rel: "noreferrer" }, hostOf(result.source_url) + " ↗")
            : "—")
        )
      : null,
    e("div", { className: "result-actions" },
      e("a", { className: "button" + (result.opener ? "" : " disabled"), href: mailtoFor(result) }, "Send email now"),
      result.opener
        ? e("button", { type: "button", className: "ghost", onClick: function () { navigator.clipboard.writeText(result.opener); } }, "Copy opener")
        : null,
      e("span", { className: "cost" }, (cost === null || cost === undefined ? "Cost —" : "Cost $" + Number(cost).toFixed(4)) + " · " + show(result.effort) + " effort")
    ),
    grounding.length
      ? e("details", { className: "grounding" },
          e("summary", null, "Grounding (" + grounding.length + ")"),
          e("table", null,
            e("thead", null, e("tr", null, e("th", null, "Field"), e("th", null, "Confidence"), e("th", null, "Citations"))),
            e("tbody", null, grounding.map(function (entry, index) {
              return e("tr", { key: index },
                e("td", null, show(entry.field)),
                e("td", null, e("span", { className: "conf " + (entry.confidence || "") }, show(entry.confidence))),
                e("td", null, (entry.urls || []).length
                  ? entry.urls.map(function (url) { return e("a", { key: url, href: url, target: "_blank", rel: "noreferrer" }, hostOf(url)); })
                  : "—")
              );
            }))
          )
        )
      : null
  );
}

function Pending(props) {
  return e("section", { className: "card", "aria-live": "polite", "aria-busy": "true" },
    e("div", { className: "pending" }, e("span", { className: "spinner" }), props.status || "Searching public signals…")
  );
}

function parseSsePart(part) {
  let eventName = "message";
  const dataLines = [];
  const lines = part.split("\\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf("event:") === 0) eventName = line.slice(6).trim();
    if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  try {
    return { event: eventName, data: JSON.parse(dataLines.join("\\n")) };
  } catch (parseError) {
    return null;
  }
}

function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  function consume() {
    buffer = buffer.replace(/\\r\\n/g, "\\n");
    let splitAt = buffer.indexOf("\\n\\n");
    while (splitAt !== -1) {
      const parsed = parseSsePart(buffer.slice(0, splitAt));
      buffer = buffer.slice(splitAt + 2);
      if (parsed) onEvent(parsed);
      splitAt = buffer.indexOf("\\n\\n");
    }
  }
  return reader.read().then(function pump(chunk) {
    if (chunk.done) {
      if (buffer.trim()) {
        const parsed = parseSsePart(buffer);
        if (parsed) onEvent(parsed);
      }
      return;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    consume();
    return reader.read().then(pump);
  });
}

function LogPanel(props) {
  const listRef = useRef(null);
  useEffect(function () {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [props.version]);
  return e("section", { className: "card" },
    e("div", { className: "panel-head" },
      e("h2", null, props.title),
      props.onClear ? e("button", { type: "button", className: "ghost", onClick: props.onClear }, "Clear") : null
    ),
    e("ol", { className: "logs", ref: listRef, "aria-live": "polite" },
      props.children.length ? props.children : e("li", { className: "empty" }, props.empty)
    )
  );
}

function Traces(props) {
  const listRef = useRef(null);
  const version = props.traces.reduce(function (n, t) { return n + 1 + (t.urls || []).length; }, 0);
  useEffect(function () {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [version]);
  return e("section", { className: "card traces-card" + (props.live ? " live" : "") },
    e("div", { className: "panel-head" },
      e("h2", null, "Search traces"),
      props.traces.length ? e("span", { className: "muted small-text" }, props.traces.length + " search" + (props.traces.length === 1 ? "" : "es")) : null
    ),
    e("ol", { className: "traces", ref: listRef, "aria-live": "polite" },
      props.traces.length
        ? props.traces.map(function (trace) {
            return e("li", { key: trace.callId },
              e("div", { className: "trace-head" },
                e("span", { className: "trace-time" }, trace.seenAt || ""),
                trace.tool ? e("span", { className: "trace-tool" }, trace.tool) : null
              ),
              e("div", null, trace.text || "Searching…"),
              (trace.urls || []).length
                ? e("div", { className: "trace-urls" }, trace.urls.map(function (url) {
                    return e("a", { key: url, href: url, target: "_blank", rel: "noreferrer", title: url }, hostOf(url) + " ↗");
                  }))
                : null
            );
          })
        : e("li", { className: "trace-empty" }, props.live ? "Waiting for the agent's first search…" : "Search traces appear here while the agent works.")
    )
  );
}

function formatLog(entry) {
  const time = (entry.time || "").slice(11, 23);
  const scope = entry.scope ? " [" + entry.scope + "]" : "";
  const details = entry.details === undefined ? "" : " " + JSON.stringify(entry.details);
  return time + " " + entry.source + scope + " " + entry.level.toUpperCase() + " " + entry.message + details;
}

function DebugLog(props) {
  return e(LogPanel, {
    title: "Debug log",
    version: props.logs.length,
    onClear: props.onClear,
    empty: "No log entries yet. Submit the form to start."
  }, props.logs.map(function (entry, index) {
    return e("li", { key: index, className: entry.source + " " + entry.level }, formatLog(entry));
  }));
}

function EffortPicker(props) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = effortById(props.value);

  useEffect(function () {
    if (!open) return;
    function close(event) { if (ref.current && !ref.current.contains(event.target)) setOpen(false); }
    document.addEventListener("mousedown", close);
    return function () { document.removeEventListener("mousedown", close); };
  }, [open]);

  function choose(id) {
    props.onChange(id);
    setOpen(false);
  }

  return e("div", { className: "effort-picker", ref: ref },
    e("button", {
      type: "button",
      id: props.id,
      className: "effort-button",
      disabled: props.disabled,
      "aria-haspopup": "listbox",
      "aria-expanded": open,
      onClick: function () { setOpen(!open); },
      onKeyDown: function (event) { if (event.key === "Escape") setOpen(false); }
    },
      e("span", null, current.label),
      e("span", { className: "muted" }, effortPrice(current)),
      e("span", { className: "caret", "aria-hidden": true }, "▾")
    ),
    open ? e("ul", { className: "effort-menu", role: "listbox" }, EFFORT_OPTIONS.map(function (option) {
      return e("li", {
        key: option.id,
        role: "option",
        tabIndex: 0,
        "aria-selected": option.id === props.value,
        className: option.id === props.value ? "selected" : "",
        onClick: function () { choose(option.id); },
        onKeyDown: function (event) {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(option.id); }
          if (event.key === "Escape") setOpen(false);
        }
      }, e("span", null, option.label), e("span", { className: "muted" }, effortPrice(option)));
    })) : null
  );
}

function modelById(models, id) {
  return (models || []).find(function (model) { return model.id === id; }) || null;
}

function modelPriceLabel(model) {
  if (!model) return "";
  const input = model.input == null ? "—" : "$" + model.input;
  const output = model.output == null ? "—" : "$" + model.output;
  return input + " / " + output + " per M tokens";
}

function modelMatchesQuery(model, query) {
  if (!query) return true;
  const hay = [model.id, model.name, model.labName, model.lab].concat(model.aliases || []).join(" ").toLowerCase();
  return query.split(/\\s+/).filter(Boolean).every(function (part) { return hay.indexOf(part) !== -1; });
}

function ModelPicker(props) {
  const models = props.models || [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [lab, setLab] = useState("all");
  const [sort, setSort] = useState("name");
  const searchRef = useRef(null);
  const current = modelById(models, props.value) || models[0] || null;
  const labs = Array.from(new Set(models.map(function (model) { return model.labName; }))).sort();

  useEffect(function () {
    if (!open) return;
    function onKey(event) { if (event.key === "Escape") setOpen(false); }
    document.addEventListener("keydown", onKey);
    const timer = setTimeout(function () { if (searchRef.current) searchRef.current.focus(); }, 0);
    return function () { document.removeEventListener("keydown", onKey); clearTimeout(timer); };
  }, [open]);

  const filtered = models.filter(function (model) {
    return (lab === "all" || model.labName === lab) && modelMatchesQuery(model, query.trim().toLowerCase());
  }).slice().sort(function (a, b) {
    if (sort === "input") return (a.input ?? 1e9) - (b.input ?? 1e9) || a.name.localeCompare(b.name);
    if (sort === "output") return (a.output ?? 1e9) - (b.output ?? 1e9) || a.name.localeCompare(b.name);
    if (sort === "lab") return a.labName.localeCompare(b.labName) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });

  const grouped = [];
  filtered.forEach(function (model) {
    const last = grouped[grouped.length - 1];
    if (!last || last.labName !== model.labName) grouped.push({ labName: model.labName, models: [model] });
    else last.models.push(model);
  });

  function choose(id) {
    props.onChange(id);
    setOpen(false);
    setQuery("");
  }

  return e("div", { className: "model-picker" },
    props.label ? e("span", { className: "muted small-text" }, props.label) : null,
    e("button", {
      type: "button",
      className: "model-trigger",
      disabled: props.disabled,
      "aria-haspopup": "dialog",
      "aria-expanded": open,
      onClick: function () { setOpen(true); }
    },
      e("span", { className: "model-trigger-main" },
        e("span", null, current ? current.name : "Choose a model"),
        e("span", { className: "model-trigger-meta" }, current ? ((current.labName || "") + " · " + modelPriceLabel(current) + (current.id === props.defaultModel ? " · default" : "")) : "No models loaded")
      ),
      e("span", { className: "caret", "aria-hidden": true }, "▾")
    ),
    open ? e("div", {
      className: "model-dialog-backdrop",
      onMouseDown: function (event) { if (event.target === event.currentTarget) setOpen(false); }
    },
      e("div", { className: "model-dialog", role: "dialog", "aria-modal": true, "aria-label": props.title || "Choose a model" },
        e("div", { className: "model-dialog-head" },
          e("div", null,
            e("h3", null, props.title || "Choose a model"),
            e("p", { className: "muted small-text" }, filtered.length + " of " + models.length + " chat models")
          ),
          e("button", { type: "button", className: "ghost", onClick: function () { setOpen(false); } }, "Close")
        ),
        e("div", { className: "model-dialog-tools" },
          e("input", {
            ref: searchRef,
            type: "search",
            placeholder: "Search by name, id, or lab",
            value: query,
            onChange: function (event) { setQuery(event.target.value); }
          }),
          e("div", { className: "model-dialog-filters" },
            e("label", { className: "muted small-text" }, "Lab ",
              e("select", { value: lab, onChange: function (event) { setLab(event.target.value); } },
                e("option", { value: "all" }, "All labs"),
                labs.map(function (name) { return e("option", { key: name, value: name }, name); })
              )
            ),
            e("span", { className: "chip-row" },
              [["name", "Name"], ["input", "Input $"], ["output", "Output $"], ["lab", "Lab"]].map(function (pair) {
                return e("button", {
                  key: pair[0],
                  type: "button",
                  className: "chip" + (sort === pair[0] ? " active" : ""),
                  onClick: function () { setSort(pair[0]); }
                }, pair[1]);
              })
            )
          )
        ),
        e("div", { className: "model-dialog-list" },
          filtered.length ? grouped.map(function (group) {
            return e(React.Fragment, { key: group.labName },
              e("div", { className: "model-dialog-group" }, group.labName),
              group.models.map(function (model) {
                return e("button", {
                  key: model.id,
                  type: "button",
                  className: "model-option" + (model.id === props.value ? " selected" : ""),
                  onClick: function () { choose(model.id); }
                },
                  e("span", { className: "model-option-main" },
                    e("span", null, model.name + (model.id === props.defaultModel ? " (default)" : "")),
                    e("span", { className: "model-option-id" }, model.id + (model.reasoning ? " · reasoning" : "") + (model.protocol === "openai" ? " · OpenAI API" : " · Anthropic API"))
                  ),
                  e("span", { className: "model-option-price" }, modelPriceLabel(model))
                );
              })
            );
          }) : e("div", { className: "model-dialog-empty" }, "No models match that search.")
        )
      )
    ) : null
  );
}

function effortHint(id) {
  const option = effortById(id);
  if (option.id === "ultra") return "Ultra keeps searching until the task is done, capped at " + money(option.budgetDollars) + ". It can run longer than 5 minutes; the hosted site stops waiting at about 4¾ minutes and cancels the run.";
  if (option.price === null) return "Auto picks the depth for each task, capped at " + money(option.budgetDollars) + " per search.";
  return "Higher effort searches deeper but takes longer. Each effort has a fixed price per search.";
}

function Effort(props) {
  return e("div", { className: "field wide" },
    e("label", { className: "label", htmlFor: "effort" }, "Effort"),
    e(EffortPicker, { id: "effort", value: props.value, onChange: props.onChange }),
    e("p", { className: "hint", style: { marginTop: 4 } }, effortHint(props.value))
  );
}

const STATUS_LABEL = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" };

function describeInput(input) {
  return Object.keys(input).map(function (key) { return key + ": " + input[key]; }).join(" · ");
}

function describeExpect(caseDef, effort) {
  const expect = caseDef.expect;
  const limits = (caseDef.limits && caseDef.limits[effort]) || expect;
  const parts = ["verdict " + [].concat(expect.verdict).join(" or ")];
  if (expect.role) parts.push("role " + expect.role.replace("_", " "));
  if (expect.personName) parts.push("person " + expect.personName);
  parts.push("≤ " + balanceMoney(limits.maxCostDollars));
  parts.push("≤ " + Math.round(limits.maxLatencyMs / 1000) + "s");
  return parts.join(" · ");
}

function compareText(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

// Search and column sort for the long eval case lists. columns: [{ key, label, text(row) }].
function useCaseTable(cases, columns) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ key: null, dir: 1 });
  const needle = query.trim().toLowerCase();
  let rows = cases;
  if (needle) {
    rows = rows.filter(function (row) {
      return columns.some(function (column) { return String(column.text(row)).toLowerCase().indexOf(needle) !== -1; });
    });
  }
  const sortColumn = columns.find(function (column) { return column.key === sort.key; });
  if (sortColumn) {
    rows = rows.slice().sort(function (a, b) { return compareText(sortColumn.text(a), sortColumn.text(b)) * sort.dir; });
  }
  function header(column) {
    const active = sort.key === column.key;
    return e("th", { key: column.key, "aria-sort": active ? (sort.dir === 1 ? "ascending" : "descending") : "none", className: column.className || "" },
      e("button", {
        type: "button",
        className: "sort" + (active ? " active" : ""),
        title: "Sort by " + column.label.toLowerCase(),
        onClick: function () {
          if (!active) setSort({ key: column.key, dir: 1 });
          else if (sort.dir === 1) setSort({ key: column.key, dir: -1 });
          else setSort({ key: null, dir: 1 });
        }
      }, column.label, e("span", { className: "sort-caret", "aria-hidden": "true" }, active ? (sort.dir === 1 ? "↑" : "↓") : "↕"))
    );
  }
  return { rows: rows, query: query, setQuery: setQuery, header: header };
}

function SelectShown(props) {
  const shown = props.rows;
  const picked = shown.filter(function (row) { return props.selected[row.id]; }).length;
  const ref = useRef(null);
  useEffect(function () {
    if (ref.current) ref.current.indeterminate = picked > 0 && picked < shown.length;
  });
  return e("th", { className: "select-col" }, e("input", {
    ref: ref,
    type: "checkbox",
    "aria-label": picked === shown.length ? "Clear the rows shown" : "Select the rows shown",
    checked: shown.length > 0 && picked === shown.length,
    disabled: props.disabled || !shown.length,
    onChange: function (event) {
      const next = Object.assign({}, props.selected);
      shown.forEach(function (row) { next[row.id] = event.target.checked; });
      props.onSelected(next);
    }
  }));
}

function CaseToolbar(props) {
  return e("div", { className: "case-toolbar" },
    e("div", { className: "case-search" },
      e("svg", { viewBox: "0 0 20 20", "aria-hidden": "true" }, e("path", { d: "M8.5 3a5.5 5.5 0 1 0 3.4 9.8l3.6 3.6 1.1-1.1-3.6-3.6A5.5 5.5 0 0 0 8.5 3zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8z", fill: "currentColor" })),
      e("input", {
        type: "search",
        value: props.query,
        placeholder: props.placeholder,
        "aria-label": props.placeholder,
        onChange: function (event) { props.onQuery(event.target.value); }
      })
    ),
    e("span", { className: "case-count" },
      e("b", null, props.selectedCount), " selected · ",
      props.shown === props.total ? props.total + " " + props.noun : props.shown + " of " + props.total + " shown"),
    e("button", { type: "button", className: "ghost small", disabled: props.disabled, onClick: props.onAdd }, props.addLabel)
  );
}

function GraderExpect(props) {
  return e("div", { className: "grader-expect-cell" },
    e("span", { className: "muted" }, "For every case that returns ready:"),
    e("ul", { className: "grader-expect" }, props.criteria.map(function (criterion) {
      return e("li", { key: criterion.name, title: criterion.rule }, criterion.summary);
    })),
    e("span", { className: "muted" }, "Cases that return cannot_verify have no opener, so there is nothing to grade.")
  );
}

function seconds(ms) {
  return typeof ms === "number" ? (ms / 1000).toFixed(1) + "s" : "—";
}

function runLabel(index) {
  return "Run " + (index + 1);
}

function CompareRuns(props) {
  const runs = props.runs;
  const graders = runs.map(function (run) { return run.judgeModel || "off"; });
  const mixedGraders = graders.some(function (grader) { return grader !== graders[0]; });
  const caseIds = [];
  const checkNames = [];
  runs.forEach(function (run) {
    run.results.forEach(function (result) {
      if (caseIds.indexOf(result.id) === -1) caseIds.push(result.id);
    });
    Object.keys(run.summary.checkTotals || {}).forEach(function (name) {
      if (checkNames.indexOf(name) === -1) checkNames.push(name);
    });
  });
  const mixedCases = runs.some(function (run) { return run.results.length !== caseIds.length; });

  function row(label, cells, key) {
    return e("tr", { key: key || label }, e("th", null, label), cells.map(function (cell, index) { return e("td", { key: index }, cell); }));
  }

  function rate(totals) {
    if (!totals) return e("span", { className: "muted" }, "—");
    const counted = totals.pass + totals.fail + totals.warn;
    return e("span", { className: totals.fail ? "bad" : totals.warn ? "meh" : "" }, totals.pass + "/" + counted + (totals.warn ? " (" + totals.warn + " warn)" : ""));
  }

  return e("section", { className: "card" },
    e("div", { className: "panel-head" },
      e("h2", null, "Compare " + runs.length + " runs"),
      e("button", { type: "button", className: "ghost", onClick: props.onClose }, "Close")
    ),
    mixedGraders ? e("div", { className: "warning" }, "These runs used different AI graders, so differences in the judge rows may come from the grader rather than from Kauntact. Compare those rows only between runs graded by the same model.") : null,
    mixedCases ? e("div", { className: "warning" }, "These runs covered different cases, so totals are not directly comparable. Use the per-case table below.") : null,
    e("div", { className: "table-scroll" },
      e("table", { className: "compare" },
        e("thead", null, e("tr", null, e("th", null, ""), runs.map(function (run, index) {
          return e("th", { key: run.id || run.at }, run.name || runLabel(index), e("small", null, new Date(run.at).toLocaleString()));
        }))),
        e("tbody", null,
          row("Effort", runs.map(function (run) { return run.effort ? effortById(run.effort).label : "Low"; })),
          row("AI grader", graders),
          row("Cases passed", runs.map(function (run) {
            return e("span", { className: "pill " + (run.passed === run.total ? "pass" : "fail") }, run.passed + "/" + run.total);
          })),
          row("Search cost", runs.map(function (run) { return money(run.cost, 4); })),
          row("Grader cost", runs.map(function (run) { return run.summary.judgeCost ? money(run.summary.judgeCost, 4) : "—"; })),
          row("Avg latency", runs.map(function (run) { return seconds(run.summary.avgLatencyMs); })),
          checkNames.map(function (name) {
            return row(name, runs.map(function (run) { return rate((run.summary.checkTotals || {})[name]); }), "check-" + name);
          })
        )
      )
    ),
    e("h3", null, "Per case"),
    e("div", { className: "table-scroll" },
      e("table", { className: "compare" },
        e("thead", null, e("tr", null, e("th", null, "Case"), runs.map(function (run, index) { return e("th", { key: run.id || run.at }, run.name || runLabel(index)); }))),
        e("tbody", null, caseIds.map(function (id) {
          return row(id, runs.map(function (run) {
            const result = run.results.find(function (candidate) { return candidate.id === id; });
            if (!result) return e("span", { className: "muted" }, "not run");
            const output = result.output || {};
            const failed = (result.checks || []).filter(function (check) { return check.status === "fail"; }).map(function (check) { return check.name; });
            return e("div", { className: "compare-cell" },
              e("span", { className: "pill " + (result.passed ? "pass" : "fail") }, result.passed ? "Pass" : "Fail"),
              e("span", null, result.error ? "error" : (output.person_name || output.verdict || "no person")),
              e("span", { className: "muted" }, money(result.cost, 4) + " · " + seconds(result.latencyMs)),
              failed.length ? e("span", { className: "bad" }, failed.join(", ")) : null
            );
          }), "case-" + id);
        }))
      )
    )
  );
}

function EvalCase(props) {
  const state = props.state;
  const result = state.result;
  if (!result) {
    return e("li", { className: "eval-case" },
      e("div", { className: "eval-row" },
        e("span", { className: "pill running" }, e("span", { className: "spinner small" }), "Running"),
        e("b", null, props.id)
      )
    );
  }
  const output = result.output || {};
  const person = output.person_name ? output.person_name + (output.person_title ? " (" + output.person_title + ")" : "") : "no person";
  const summary = result.error ? "error: " + result.error : (output.verdict || "no verdict") + " · " + person + " · " + (output.signal_date || "no date");
  const seconds = ((result.latencyMs || result.durationMs || 0) / 1000).toFixed(1) + "s";
  const checks = (result.checks || []).filter(function (check) { return check.status !== "skip"; });
  return e("li", { className: "eval-case" },
    e("details", { open: !result.passed },
      e("summary", { className: "eval-row" },
        e("span", { className: "pill " + (result.passed ? "pass" : "fail") }, result.passed ? "Pass" : "Fail"),
        e("b", null, result.id),
        e("span", { className: "muted eval-summary" }, summary),
        e("span", { className: "eval-meta" }, money(result.cost, 4) + " · " + seconds)
      ),
      output.opener ? e("blockquote", { className: "opener small" }, output.opener) : null,
      output.source_url ? e("div", { className: "eval-source" }, "Source: ", e("a", { href: output.source_url, target: "_blank", rel: "noreferrer" }, hostOf(output.source_url) + " ↗")) : null,
      e("ul", { className: "checks" }, checks.map(function (check, index) {
        return e("li", { key: index },
          e("span", { className: "check-status " + check.status }, STATUS_LABEL[check.status]),
          e("span", null, check.name, check.detail ? e("span", { className: "muted" }, " — " + check.detail) : null)
        );
      }))
    )
  );
}

function draftFromCase(caseDef) {
  const input = (caseDef && caseDef.input) || {};
  const expect = (caseDef && caseDef.expect) || {};
  const verdicts = [].concat(expect.verdict || "ready");
  return {
    id: caseDef ? caseDef.id : "",
    accountName: input.accountName || "",
    domain: input.domain || "",
    persona: input.persona || "",
    personName: input.personName || "",
    exclusion: input.exclusion || "",
    verdict: verdicts.length > 1 ? "either" : verdicts[0],
    role: expect.role || "",
    expectedPerson: expect.personName || "",
    maxCostDollars: String(expect.maxCostDollars === undefined ? 0.05 : expect.maxCostDollars),
    maxLatencySeconds: String(Math.round((expect.maxLatencyMs === undefined ? 60000 : expect.maxLatencyMs) / 1000))
  };
}

function CaseEditor(props) {
  const [draft, setDraft] = useState(draftFromCase(props.caseDef));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const editing = Boolean(props.caseDef);
  function set(key) { return function (value) { setDraft(function (current) { const next = Object.assign({}, current); next[key] = value; return next; }); }; }
  function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const body = {
      id: draft.id.trim(),
      input: { accountName: draft.accountName, domain: draft.domain, persona: draft.persona, personName: draft.personName, exclusion: draft.exclusion },
      expect: {
        verdict: draft.verdict === "either" ? ["ready", "cannot_verify"] : draft.verdict,
        role: draft.role || undefined,
        personName: draft.expectedPerson || undefined,
        maxCostDollars: Number(draft.maxCostDollars),
        maxLatencyMs: Number(draft.maxLatencySeconds) * 1000
      }
    };
    api(editing ? "/api/evals/cases/" + encodeURIComponent(props.caseDef.id) : "/api/evals/cases", { method: editing ? "PUT" : "POST", json: body })
      .then(function (saved) { props.onSaved(saved, editing); })
      .catch(function (saveError) { setError(saveError.message); setSaving(false); });
  }
  return e("form", { className: "case-editor", onSubmit: save },
    e("h3", null, editing ? "Edit case " + props.caseDef.id : "New eval case"),
    e("div", { className: "grid" },
      e(Field, { id: "case-id", label: "Case id", value: draft.id, readOnly: editing, onChange: set("id"), placeholder: "lowercase-with-dashes" }),
      e(Field, { id: "case-account", label: "Account name", value: draft.accountName, onChange: set("accountName"), placeholder: "Acme" }),
      e(Field, { id: "case-domain", label: "Domain name", value: draft.domain, onChange: set("domain"), placeholder: "acme.com" }),
      e(Field, { id: "case-persona", label: "Persona", value: draft.persona, onChange: set("persona"), placeholder: "Optional" }),
      e(Field, { id: "case-person", label: "Person name", value: draft.personName, onChange: set("personName"), placeholder: "Optional" }),
      e(Field, { id: "case-exclusion", label: "Exclusion rules", value: draft.exclusion, onChange: set("exclusion"), placeholder: "Optional" }),
      e("label", { className: "field" }, e("span", null, "Expected verdict"),
        e("select", { value: draft.verdict, onChange: function (event) { set("verdict")(event.target.value); } },
          e("option", { value: "ready" }, "Ready"), e("option", { value: "cannot_verify" }, "Cannot verify"), e("option", { value: "either" }, "Either"))),
      e("label", { className: "field" }, e("span", null, "Expected role"),
        e("select", { value: draft.role, onChange: function (event) { set("role")(event.target.value); } },
          e("option", { value: "" }, "Any"), e("option", { value: "cro" }, "CRO"), e("option", { value: "vp_engineering" }, "VP of Engineering"), e("option", { value: "cto" }, "CTO"))),
      e(Field, { id: "case-expected-person", label: "Expected person contains", value: draft.expectedPerson, onChange: set("expectedPerson"), placeholder: "Optional, e.g. a last name" }),
      e(Field, { id: "case-cost", label: "Max cost at low effort ($)", value: draft.maxCostDollars, onChange: set("maxCostDollars"), placeholder: "0.05" }),
      e(Field, { id: "case-latency", label: "Max latency at low effort (seconds)", value: draft.maxLatencySeconds, onChange: set("maxLatencySeconds"), placeholder: "60" })
    ),
    error ? e("div", { className: "error", role: "alert" }, error) : null,
    e("div", { className: "actions" },
      e("button", { type: "submit", disabled: saving }, saving ? "Saving…" : editing ? "Save case" : "Add case"),
      e("button", { type: "button", className: "ghost", onClick: props.onCancel }, "Cancel")
    )
  );
}

function RunRename(props) {
  const [draft, setDraft] = useState(props.name || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    api(props.url, { method: "PATCH", json: { name: draft.trim() } })
      .then(function (saved) { props.onSaved(saved.name || ""); })
      .catch(function (renameError) { setError(renameError.message); setSaving(false); });
  }
  return e("form", { className: "run-rename", onSubmit: save },
    e("input", {
      type: "text",
      value: draft,
      maxLength: 80,
      autoFocus: true,
      placeholder: "Run name (leave empty to remove)",
      "aria-label": "New run name",
      onChange: function (event) { setDraft(event.target.value); }
    }),
    e("button", { type: "submit", disabled: saving }, saving ? "Saving…" : "Save"),
    e("button", { type: "button", className: "ghost", disabled: saving, onClick: props.onCancel }, "Cancel"),
    error ? e("span", { className: "bad small-text", role: "alert" }, error) : null
  );
}

function Evals(props) {
  const [cases, setCases] = useState([]);
  const [editingCase, setEditingCase] = useState(null);
  const [effort, setEffort] = useState("low");
  const [selected, setSelected] = useState({});
  const [sources, setSources] = useState(true);
  const [judgeInfo, setJudgeInfo] = useState({ available: false, defaultModel: "", models: [] });
  const [judge, setJudge] = useState(true);
  const [judgeModel, setJudgeModel] = useState("");
  const [comparing, setComparing] = useState({});
  const [compareOpen, setCompareOpen] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [running, setRunning] = useState(false);
  const [order, setOrder] = useState([]);
  const [states, setStates] = useState({});
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [startedAt, setStartedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [selfTest, setSelfTest] = useState(null);
  const [history, setHistory] = useState([]);
  const [runName, setRunName] = useState("");
  const [shownName, setShownName] = useState("");
  const [shownId, setShownId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);

  function loadCases(first) {
    return api("/api/evals/cases").then(function (data) {
      setCases(data.cases);
      if (first) {
        setJudgeInfo(data.judge);
        setJudgeModel(data.judge.defaultModel);
      }
      setSelected(function (current) {
        const next = {};
        data.cases.forEach(function (caseDef) { next[caseDef.id] = first || current[caseDef.id] === undefined ? true : current[caseDef.id]; });
        return next;
      });
    }).catch(function (casesError) {
      setError("Could not load eval cases: " + casesError.message);
    });
  }

  function loadRuns() {
    return api("/api/evals/runs").then(function (data) { setHistory(data.runs); }).catch(function (runsError) {
      props.log("warn", "Could not load eval runs", { message: runsError.message });
    });
  }

  useEffect(function () { loadCases(true); loadRuns(); }, []);

  function caseSaved(saved, edited) {
    props.log("info", edited ? "Eval case updated" : "Eval case added", { id: saved.id });
    setEditingCase(null);
    loadCases(false);
  }

  function removeCase(caseDef) {
    if (!window.confirm("Delete the eval case " + caseDef.id + "? This can't be undone.")) return;
    api("/api/evals/cases/" + encodeURIComponent(caseDef.id), { method: "DELETE" })
      .then(function () { props.log("info", "Eval case deleted", { id: caseDef.id }); loadCases(false); })
      .catch(function (deleteError) { setError(deleteError.message); });
  }

  function clearRuns() {
    if (!window.confirm("Delete all saved eval runs for everyone?")) return;
    api("/api/evals/runs", { method: "DELETE" })
      .then(function () { setHistory([]); setComparing({}); setCompareOpen(false); })
      .catch(function (clearError) { setError(clearError.message); });
  }

  useEffect(function () {
    if (!running) return;
    const timer = setInterval(function () { setNow(Date.now()); }, 500);
    return function () { clearInterval(timer); };
  }, [running]);

  const ids = cases.filter(function (caseDef) { return selected[caseDef.id]; }).map(function (caseDef) { return caseDef.id; });
  const finishedResults = order.map(function (id) { return states[id] && states[id].result; }).filter(Boolean);
  const spentSoFar = finishedResults.reduce(function (sum, result) { return sum + (result.cost || 0); }, 0);
  const passedSoFar = finishedResults.filter(function (result) { return result.passed; }).length;

  const effortOption = effortById(effort);
  const worstCase = ids.length * maxCostFor(effort);
  const showGrader = judge && judgeInfo.available;
  const nonDefaultGrader = showGrader && judgeModel && judgeModel !== judgeInfo.defaultModel;
  const compareRuns = history.filter(function (entry) { return comparing[entry.id]; });
  const caseColumns = [
    { key: "id", label: "Case", text: function (caseDef) { return caseDef.id; } },
    { key: "input", label: "Input", text: function (caseDef) { return describeInput(caseDef.input); } },
    { key: "expect", label: "Expectations", text: function (caseDef) { return describeExpect(caseDef, effort); } }
  ];
  const caseTable = useCaseTable(cases, caseColumns);

  async function runEvals() {
    if (worstCase > 2 && !window.confirm("This eval run can cost up to " + money(worstCase) + " (" + ids.length + " cases at " + effortOption.label + " effort). Continue?")) return;
    setError("");
    setSummary(null);
    setOrder([]);
    setStates({});
    setRunning(true);
    setStartedAt(Date.now());
    setNow(Date.now());
    const name = runName.trim();
    setShownName(name);
    setShownId(null);
    const useJudge = judge && judgeInfo.available;
    const runModel = useJudge ? judgeModel : null;
    props.log("info", "Eval run requested", { name: name || null, ids: ids, effort: effort, concurrency: concurrency, sources: sources, judgeModel: runModel });
    const collected = [];
    try {
      const response = await fetch("/api/evals/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, ids: ids, effort: effort, concurrency: concurrency, sources: sources, judge: useJudge, judgeModel: judgeModel || undefined })
      });
      if ((response.headers.get("Content-Type") || "").indexOf("text/event-stream") === -1) {
        const body = await response.json();
        throw new Error(body.error || "The eval run failed.");
      }
      await readSse(response, function (message) {
        if (message.event === "log") {
          props.addServerLog(message.data);
        } else if (message.event === "case-start") {
          setOrder(function (current) { return current.concat([message.data.id]); });
          setStates(function (current) { const next = Object.assign({}, current); next[message.data.id] = {}; return next; });
        } else if (message.event === "case-result") {
          collected.push(message.data);
          props.onSpend({ exa: message.data.cost, llm: message.data.judgeCost });
          setStates(function (current) { const next = Object.assign({}, current); next[message.data.id] = { result: message.data }; return next; });
        } else if (message.event === "done") {
          setSummary(message.data);
          setShownId(message.data.runId || null);
          loadRuns();
        } else if (message.event === "error") {
          setError(message.data.error || "The eval run failed.");
        }
      });
    } catch (runError) {
      props.log("error", "Eval run failed", { message: runError.message });
      setError(runError.message);
    } finally {
      setRunning(false);
      setNow(Date.now());
      props.onFinished();
    }
  }

  async function runSelfTests() {
    props.log("info", "Self-tests requested");
    try {
      const response = await fetch("/api/evals/self-test", { method: "POST" });
      const data = await response.json();
      setSelfTest(data);
      props.log(data.passed === data.total ? "info" : "warn", "Self-tests finished", { passed: data.passed, total: data.total });
    } catch (selfTestError) {
      setError("Self-tests failed to run: " + selfTestError.message);
    }
  }

  function showHistory(entry) {
    const nextStates = {};
    entry.results.forEach(function (result) { nextStates[result.id] = { result: result }; });
    setOrder(entry.results.map(function (result) { return result.id; }));
    setStates(nextStates);
    setSummary(entry.summary);
    setShownName(entry.name || "");
    setShownId(entry.id);
    setStartedAt(null);
  }

  function runRenamed(entry, name) {
    setRenamingId(null);
    if (shownId === entry.id) setShownName(name);
    loadRuns();
  }

  const checkTotals = summary ? Object.keys(summary.checkTotals).map(function (name) {
    return Object.assign({ name: name }, summary.checkTotals[name]);
  }) : [];

  return e("div", { className: "evals" },
    e("section", { className: "card" },
      e("div", { className: "panel-head" },
        e("h2", null, "Kauntact evals"),
        e("span", { className: "muted small-text" }, "Each case runs the real agent at the effort you pick, then rule-based checks and an optional AI grader score the output.")
      ),
      e("div", { className: "run-panel" },
        e("div", { className: "eval-effort" },
          e("label", { className: "eval-label", htmlFor: "eval-effort" }, "Effort"),
          e(EffortPicker, { id: "eval-effort", value: effort, disabled: running, onChange: setEffort }),
          e("span", { className: "muted small-text" }, "Cost and latency limits scale with effort from each case's low-effort baseline." + (effortOption.price === null ? " " + effortHint(effort) : ""))
        ),
        e("div", { className: "eval-options" },
          e("label", { className: "inline-check" },
            e("input", { type: "checkbox", checked: sources, disabled: running, onChange: function (event) { setSources(event.target.checked); } }),
            "Fetch source pages"
          ),
          e("label", { className: "inline-check", title: judgeInfo.available ? "Grades each opener and source with an LLM" : "Set GROVE_API_KEY and GROVE_ENDPOINT on the server to enable the AI grader." },
            e("input", { type: "checkbox", checked: judge && judgeInfo.available, disabled: running || !judgeInfo.available, onChange: function (event) { setJudge(event.target.checked); } }),
            "AI grader",
            judgeInfo.available ? null : e("span", { className: "muted" }, " — not configured")
          ),
          judgeInfo.available && judge ? e(ModelPicker, {
            label: "AI grader",
            title: "Choose the AI grader",
            models: judgeInfo.models,
            value: judgeModel,
            defaultModel: judgeInfo.defaultModel,
            disabled: running,
            onChange: setJudgeModel
          }) : null,
          e("label", { className: "inline-check" }, "Run ",
            e("select", { value: concurrency, disabled: running, onChange: function (event) { setConcurrency(Number(event.target.value)); } },
              [1, 2, 3].map(function (n) { return e("option", { key: n, value: n }, n); })
            ),
            " at a time"
          )
        ),
        judgeInfo.available && judge ? e("p", { className: nonDefaultGrader ? "warning" : "muted small-text" },
          nonDefaultGrader
            ? "Not recommended: keep " + judgeInfo.defaultModel + " as the grader. Switching graders changes the scoring itself, so a different pass rate says more about the grader than about Kauntact, and these runs can't be compared fairly with runs graded by " + judgeInfo.defaultModel + "."
            : "Leave the grader on " + judgeInfo.defaultModel + ". Changing it from the UI doesn't tell you anything about Kauntact's quality; it only changes who is grading.") : null,
        effortOption.id === "ultra" || effortOption.id === "xhigh" || effortOption.id === "auto"
          ? e("p", { className: "warning" }, "On the hosted site an eval run must finish within 5 minutes. At " + effortOption.label + " effort, run one or two cases at a time, or use npm run eval -- --effort=" + effortOption.id + " locally.")
          : null,
        showGrader ? e("details", { className: "grader-panel" },
          e("summary", null, "What the AI grader also checks"),
          e(GraderExpect, { criteria: judgeInfo.criteria || [] })
        ) : null,
        e("div", { className: "run-bar" },
          e("label", { className: "run-name" }, "Name",
            e("input", {
              type: "text",
              value: runName,
              maxLength: 80,
              disabled: running,
              placeholder: "Optional, so you can find this run later",
              "aria-label": "Run name",
              onChange: function (event) { setRunName(event.target.value); }
            })
          ),
          e("button", { type: "button", disabled: running || !ids.length, onClick: runEvals },
            running ? "Running…" : "Run " + ids.length + " case" + (ids.length === 1 ? "" : "s") + (effortOption.price === null ? " · up to " + money(worstCase) : " · ≈ " + balanceMoney(worstCase))),
          e("button", { type: "button", className: "ghost", disabled: running, onClick: runSelfTests }, "Run self-tests (free)"),
          e("span", { className: "estimate" }, "Each case is a real, paid search.")
        )
      ),
      error ? e("div", { className: "error", role: "alert" }, error) : null,
      e("div", { className: "section-label" }, "Cases"),
      e(CaseToolbar, {
        query: caseTable.query,
        onQuery: caseTable.setQuery,
        placeholder: "Search cases, inputs, expectations",
        shown: caseTable.rows.length,
        total: cases.length,
        noun: "cases",
        selectedCount: ids.length,
        disabled: running,
        addLabel: "+ Add case",
        onAdd: function () { setEditingCase("new"); }
      }),
      e("div", { className: "case-scroll" },
        e("table", { className: "cases" },
          e("thead", null, e("tr", null,
            e(SelectShown, { rows: caseTable.rows, selected: selected, onSelected: setSelected, disabled: running }),
            caseColumns.map(caseTable.header)
          )),
          e("tbody", null,
            caseTable.rows.length ? null : e("tr", { className: "empty-row" }, e("td", { colSpan: 4 }, cases.length ? "No cases match that search." : "No cases yet. Add one with + Add case.")),
            caseTable.rows.map(function (caseDef) {
              return e("tr", { key: caseDef.id },
                e("td", null, e("input", {
                  type: "checkbox",
                  checked: Boolean(selected[caseDef.id]),
                  disabled: running,
                  "aria-label": "Include " + caseDef.id,
                  onChange: function (event) { const next = Object.assign({}, selected); next[caseDef.id] = event.target.checked; setSelected(next); }
                })),
                e("td", null, e("b", null, caseDef.id),
                  e("div", { className: "case-links" },
                    e("button", { type: "button", className: "link", disabled: running, onClick: function () { setEditingCase(caseDef); } }, "Edit"),
                    e("button", { type: "button", className: "link danger", disabled: running, onClick: function () { removeCase(caseDef); } }, "Delete"))),
                e("td", { className: "muted" }, describeInput(caseDef.input)),
                e("td", { className: "muted" }, describeExpect(caseDef, effort))
              );
            })
          )
        )
      ),
      editingCase
        ? e(CaseEditor, { key: editingCase === "new" ? "new" : editingCase.id, caseDef: editingCase === "new" ? null : editingCase, onSaved: caseSaved, onCancel: function () { setEditingCase(null); } })
        : e("p", { className: "muted small-text" }, "Cases are saved and shared by everyone. Click a column name to sort.")
    ),
    selfTest ? e("section", { className: "card" },
      e("div", { className: "panel-head" },
        e("h2", null, "Self-tests"),
        e("span", { className: "pill " + (selfTest.passed === selfTest.total ? "pass" : "fail") }, selfTest.passed + "/" + selfTest.total + " passed")
      ),
      e("p", { className: "muted small-text" }, "Checks the graders against hand-written outputs, with no paid searches. Signal window " + selfTest.window.start + " to " + selfTest.window.end + "."),
      e("details", { open: selfTest.passed !== selfTest.total },
        e("summary", { className: "muted" }, "All " + selfTest.total + " tests"),
        e("ul", { className: "checks" }, selfTest.results.map(function (test) {
          return e("li", { key: test.name },
            e("span", { className: "check-status " + (test.ok ? "pass" : "fail") }, test.ok ? "PASS" : "FAIL"),
            e("span", null, test.name, test.ok ? null : e("span", { className: "muted" }, " — expected [" + test.expected.join(", ") + "], got [" + test.failed.join(", ") + "]"))
          );
        }))
      )
    ) : null,
    order.length || running ? e("section", { className: "card" },
      shownName ? e("h3", { className: "run-title" }, shownName) : null,
      e("div", { className: "stats" },
        e("div", null, e("span", { className: "stat-label" }, "Passed"), e("span", { className: "stat" }, passedSoFar + "/" + (summary ? summary.totalCases : order.length || ids.length))),
        e("div", null, e("span", { className: "stat-label" }, "Cost"), e("span", { className: "stat" }, money(summary ? summary.cost : spentSoFar, 4))),
        summary && summary.judgeCost ? e("div", null, e("span", { className: "stat-label" }, "Grader cost"), e("span", { className: "stat" }, money(summary.judgeCost, 4))) : null,
        summary && summary.avgLatencyMs ? e("div", null, e("span", { className: "stat-label" }, "Avg latency"), e("span", { className: "stat" }, seconds(summary.avgLatencyMs))) : null,
        e("div", null, e("span", { className: "stat-label" }, "Effort · grader"), e("span", { className: "stat small" },
          effortById(summary && summary.effort ? summary.effort : effort).label + " · " + (summary ? summary.judgeModel || "no grader" : (judge && judgeInfo.available ? judgeModel : "no grader")))),
        startedAt ? e("div", null, e("span", { className: "stat-label" }, "Elapsed"), e("span", { className: "stat" }, Math.round((now - startedAt) / 1000) + "s")) : null,
        summary && summary.window ? e("div", null, e("span", { className: "stat-label" }, "Signal window"), e("span", { className: "stat small" }, summary.window.start + " → " + summary.window.end)) : null
      ),
      checkTotals.length ? e("table", { className: "totals" },
        e("thead", null, e("tr", null, e("th", null, "Check"), e("th", null, "Pass"), e("th", null, "Fail"), e("th", null, "Warn"))),
        e("tbody", null, checkTotals.map(function (row) {
          return e("tr", { key: row.name },
            e("td", null, row.name),
            e("td", null, row.pass),
            e("td", { className: row.fail ? "bad" : "" }, row.fail),
            e("td", { className: row.warn ? "meh" : "" }, row.warn)
          );
        }))
      ) : null,
      e("ul", { className: "eval-cases" }, order.map(function (id) {
        return e(EvalCase, { key: id, id: id, state: states[id] || {} });
      }))
    ) : null,
    history.length ? e("section", { className: "card" },
      e("div", { className: "panel-head" },
        e("h2", null, "Recent runs"),
        e("div", { className: "head-actions" },
          e("button", { type: "button", disabled: compareRuns.length < 2, onClick: function () { setCompareOpen(true); } },
            "Compare" + (compareRuns.length ? " (" + compareRuns.length + ")" : "")),
          e("button", { type: "button", className: "ghost", onClick: clearRuns }, "Clear")
        )
      ),
      e("ul", { className: "history" }, history.map(function (entry) {
        const renaming = renamingId === entry.id;
        return e("li", { key: entry.id },
          e("input", {
            type: "checkbox",
            "aria-label": "Compare " + (entry.name || "run from " + new Date(entry.at).toLocaleString()),
            checked: Boolean(comparing[entry.id]),
            onChange: function (event) { const next = Object.assign({}, comparing); next[entry.id] = event.target.checked; setComparing(next); }
          }),
          renaming
            ? e(RunRename, {
              name: entry.name || "",
              url: "/api/evals/runs/" + encodeURIComponent(entry.id),
              onSaved: function (name) { runRenamed(entry, name); },
              onCancel: function () { setRenamingId(null); }
            })
            : e("button", { type: "button", className: "link", disabled: running, onClick: function () { showHistory(entry); } },
              entry.name || new Date(entry.at).toLocaleString()),
          renaming ? null : entry.name ? e("span", { className: "muted small-text" }, new Date(entry.at).toLocaleString()) : null,
          renaming ? null : e("button", { type: "button", className: "link small-text", disabled: running, onClick: function () { setRenamingId(entry.id); } }, "Rename"),
          e("span", { className: "pill " + (entry.passed === entry.total ? "pass" : "fail") }, entry.passed + "/" + entry.total),
          e("span", { className: "muted" }, effortById(entry.effort || "low").label + " · " + (entry.judgeModel || "no grader")),
          e("span", { className: "muted" }, money(entry.cost, 4)),
          entry.source === "cli" ? e("span", { className: "muted small-text" }, "from npm run eval") : null
        );
      })),
      e("p", { className: "muted small-text" }, "Name a run before you start it, or rename it here later with Rename. Tick two or more runs and press Compare. Saved for everyone, last 20 runs.")
    ) : null,
    compareOpen && compareRuns.length >= 2 ? e(CompareRuns, { runs: compareRuns.slice().reverse(), onClose: function () { setCompareOpen(false); } }) : null
  );
}

const MAX_BATCH_ROWS = 50;
const BATCH_CONCURRENCY = 3;
const INPUT_ALIASES = {
  accountName: ["accountname", "account", "company", "companyname", "organization"],
  domain: ["domain", "domainname", "website", "companydomain"],
  persona: ["persona", "role", "targetrole"],
  personName: ["person", "personname", "contact", "contactname", "fullname"],
  exclusion: ["exclusion", "exclusions", "exclusionrules", "exclude"]
};
const INPUT_LABELS = { accountName: "account name", domain: "domain", persona: "persona", personName: "person", exclusion: "exclusion" };
const RESULT_COLUMNS = ["company", "person_name", "person_title", "signal", "signal_date", "source_url", "opener", "subject", "person_email", "verdict", "effort", "costDollars.total"];
const GROUNDING_FIELDS = ["person_name", "person_title", "signal", "signal_date", "source_url", "opener", "subject", "person_email"];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell); cell = "";
    } else if (ch === "\\n" || ch === "\\r") {
      if (ch === "\\r" && source[i + 1] === "\\n") i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(function (cells) { return cells.some(function (value) { return value.trim() !== ""; }); });
}

function mapHeaders(headers) {
  const normalized = headers.map(function (header) { return header.toLowerCase().replace(/[^a-z]/g, ""); });
  const mapping = {};
  Object.keys(INPUT_ALIASES).forEach(function (field) {
    const index = normalized.findIndex(function (name) { return INPUT_ALIASES[field].indexOf(name) !== -1; });
    if (index !== -1) mapping[field] = index;
  });
  return mapping;
}

function readCsvFile(fileName, text) {
  const rows = parseCsv(text);
  if (!rows.length) return { fileName: fileName, error: "The file is empty." };
  const headers = rows[0].map(function (header) { return header.trim(); });
  const mapping = mapHeaders(headers);
  if (mapping.accountName === undefined && mapping.domain === undefined) {
    return { fileName: fileName, error: "No account name or domain column found. Use headers like account name, domain, persona, person, exclusion." };
  }
  const body = rows.slice(1).map(function (cells) { return headers.map(function (_, index) { return cells[index] === undefined ? "" : cells[index]; }); });
  if (!body.length) return { fileName: fileName, error: "The file has a header row but no data rows." };
  if (body.length > MAX_BATCH_ROWS) return { fileName: fileName, error: "The file has " + body.length + " rows. Upload at most " + MAX_BATCH_ROWS + " rows at a time." };
  return { fileName: fileName, headers: headers, mapping: mapping, rows: body };
}

function inputFromRow(csv, cells) {
  const input = {};
  Object.keys(INPUT_ALIASES).forEach(function (field) {
    input[field] = csv.mapping[field] === undefined ? "" : String(cells[csv.mapping[field]] || "").trim();
  });
  return input;
}

function groundingKey(field) {
  return String(field || "").replace(/^structured\\./, "");
}

function outputColumns(csv, jobs) {
  const fields = GROUNDING_FIELDS.slice();
  jobs.forEach(function (job) {
    ((job.result && job.result.grounding) || []).forEach(function (entry) {
      const key = groundingKey(entry.field);
      if (key && fields.indexOf(key) === -1) fields.push(key);
    });
  });
  const taken = csv.headers.map(function (header) { return header.toLowerCase(); });
  const resultColumns = RESULT_COLUMNS.concat(fields.reduce(function (list, key) {
    return list.concat(["grounding." + key + ".confidence", "grounding." + key + ".urls"]);
  }, []), ["error"]);
  return resultColumns.map(function (name) {
    return { key: name, header: taken.indexOf(name.toLowerCase()) === -1 ? name : "kauntact." + name };
  });
}

function flattenResult(job) {
  const result = job.result || {};
  const flat = {};
  RESULT_COLUMNS.forEach(function (name) {
    flat[name] = name === "costDollars.total" ? (result.costDollars ? result.costDollars.total : null) : result[name];
  });
  (result.grounding || []).forEach(function (entry) {
    const key = groundingKey(entry.field);
    flat["grounding." + key + ".confidence"] = entry.confidence;
    flat["grounding." + key + ".urls"] = (entry.urls || []).join(" ");
  });
  flat.error = job.error || "";
  return flat;
}

function csvCell(value, sanitize) {
  let text = value === null || value === undefined ? "" : String(value);
  if (sanitize && /^[=+\\-@\\t\\r]/.test(text)) text = "'" + text;
  return /[",\\n\\r]/.test(text) || text !== text.trim() ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function buildOutputCsv(csv, jobs) {
  const columns = outputColumns(csv, jobs);
  const lines = [csv.headers.map(function (header) { return csvCell(header); }).concat(columns.map(function (column) { return csvCell(column.header); })).join(",")];
  jobs.forEach(function (job) {
    const flat = flattenResult(job);
    lines.push(job.cells.map(function (value) { return csvCell(value); })
      .concat(columns.map(function (column) { return csvCell(flat[column.key], true); })).join(","));
  });
  return lines.join("\\r\\n") + "\\r\\n";
}

function downloadText(fileName, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function downloadTemplate() {
  downloadText("kauntact-template.csv", "account name,domain,persona,person,exclusion\\r\\nStripe,stripe.com,CRO,,\\r\\n,vercel.com,VP of Engineering,,Vercel Ship\\r\\n");
}

async function streamRun(payload, handlers, signal) {
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: signal
  });
  const type = response.headers.get("Content-Type") || "";
  if (handlers.onHeaders) handlers.onHeaders(response, type);
  if (type.indexOf("text/event-stream") === -1) {
    const body = await response.json();
    if (!response.ok && handlers.onLog) (body.logs || []).forEach(handlers.onLog);
    return response.ok ? { result: body } : { error: body.error || "The run failed." };
  }
  const outcome = {};
  await readSse(response, function (message) {
    if (handlers.onEvent) handlers.onEvent(message);
    if (message.event === "log") { if (handlers.onLog) handlers.onLog(message.data); }
    else if (message.event === "status") { if (handlers.onStatus) handlers.onStatus(message.data.message); }
    else if (message.event === "trace") { if (handlers.onTrace) handlers.onTrace(message.data); }
    else if (message.event === "result") outcome.result = message.data;
    else if (message.event === "error") outcome.error = message.data.error || "The run failed.";
  });
  if (!outcome.result && !outcome.error) outcome.error = "The stream ended without a result.";
  return outcome;
}

const JOB_LABEL = { queued: "Queued", running: "Running", ready: "Ready", cannot_verify: "Cannot verify", error: "Error", skipped: "Skipped" };

function jobStatus(job) {
  if (job.status !== "done") return job.status;
  return job.result && job.result.verdict === "ready" ? "ready" : "cannot_verify";
}

function BatchProgress(props) {
  const jobs = props.jobs;
  const finished = jobs.filter(function (job) { return job.status === "done" || job.status === "error" || job.status === "skipped"; });
  const ready = jobs.filter(function (job) { return jobStatus(job) === "ready"; }).length;
  const spent = jobs.reduce(function (sum, job) { return sum + ((job.result && job.result.costDollars && job.result.costDollars.total) || 0); }, 0);
  const percent = jobs.length ? Math.round((finished.length / jobs.length) * 100) : 0;
  return e("section", { className: "card batch" },
    e("div", { className: "panel-head" },
      e("div", null,
        e("h2", null, props.fileName),
        e("div", { className: "muted small-text" }, finished.length + " of " + jobs.length + " rows done · " + ready + " ready · " + money(spent, 4) + " spent")
      ),
      e("div", { className: "head-actions" },
        props.running ? e("button", { type: "button", className: "ghost", onClick: props.onStop }, "Stop") : null,
        e("button", { type: "button", disabled: !finished.length, onClick: props.onDownload }, props.running ? "Download so far" : "Download CSV")
      )
    ),
    e("div", { className: "progress", role: "progressbar", "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 },
      e("span", { style: { width: percent + "%" } })
    ),
    e("div", { className: "table-scroll batch-table" },
      e("table", null,
        e("thead", null, e("tr", null, e("th", null, "#"), e("th", null, "Account"), e("th", null, "Status"), e("th", null, "Person"), e("th", null, "Opener"), e("th", null, "Cost"))),
        e("tbody", null, jobs.map(function (job, index) {
          const status = jobStatus(job);
          const result = job.result || {};
          const cost = result.costDollars && result.costDollars.total;
          return e("tr", { key: index },
            e("td", { className: "muted" }, index + 1),
            e("td", null, result.company || job.input.accountName || job.input.domain || "—",
              e(AlertButton, { query: result.company || job.input.accountName, onAlert: props.onAlert })),
            e("td", null, e("span", { className: "pill " + (status === "ready" ? "pass" : status === "running" || status === "queued" ? "running" : "fail") },
              status === "running" ? e("span", { className: "spinner small" }) : null, JOB_LABEL[status])),
            e("td", null, result.person_name ? e("span", null, result.person_name,
              e(AlertButton, { query: result.person_name + (result.company ? " " + result.company : ""), onAlert: props.onAlert }),
              result.person_title ? e("small", { className: "muted block" }, result.person_title) : null) : (job.error ? e("span", { className: "muted" }, job.error) : "—")),
            e("td", { className: "batch-opener" }, result.opener || "—"),
            e("td", { className: "muted" }, typeof cost === "number" ? money(cost, 4) : "—")
          );
        }))
      )
    )
  );
}

let debugSink = null;

function api(path, options) {
  const init = Object.assign({}, options || {});
  if (init.json !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(init.json);
    delete init.json;
  }
  return fetch(path, init).then(function (response) {
    return response.json().catch(function () { return {}; }).then(function (body) {
      if (!response.ok) {
        if (debugSink) debugSink("error", (init.method || "GET") + " " + path + " failed (" + response.status + ")", { message: body.debug || body.error });
        throw new Error(body.error || "Request failed (" + response.status + ")");
      }
      return body;
    });
  });
}

function timeAgo(value) {
  const ms = Date.now() - new Date(value).getTime();
  if (!isFinite(ms)) return "";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + "h ago";
  return Math.round(hours / 24) + "d ago";
}

function BellIcon(props) {
  return e("svg", { viewBox: "0 0 24 24", width: props.size || 15, height: props.size || 15, "aria-hidden": true, focusable: "false" },
    e("path", { fill: "currentColor", d: "M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6v-5a7 7 0 0 0-5.5-6.84V3a1.5 1.5 0 0 0-3 0v1.16A7 7 0 0 0 5 11v5l-2 2v1h18v-1z" })
  );
}

function AlertButton(props) {
  if (!props.query) return null;
  return e("button", {
    type: "button",
    className: "bell-button",
    title: "Get news alerts about " + props.query,
    "aria-label": "Get news alerts about " + props.query,
    onClick: function (event) { props.onAlert(props.query, props.source || "result", event.currentTarget.getBoundingClientRect()); }
  }, e(BellIcon, null));
}

function popoverStyle(rect, width) {
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left));
  const below = rect.bottom + 8;
  const top = below + 230 > window.innerHeight ? Math.max(12, rect.top - 238) : below;
  return { left: left, top: top, width: width };
}

function AlertComposer(props) {
  const draft = props.draft;
  const [query, setQuery] = useState(draft.query);
  const [cadence, setCadence] = useState("1d");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(function () {
    function onKey(event) { if (event.key === "Escape") props.onClose(); }
    function onOutside() { props.onClose(); }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    return function () {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
    };
  }, []);

  function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    api("/api/alerts", { method: "POST", json: { query: query, cadence: cadence, source: draft.source } })
      .then(function (alert) { props.onSaved(alert); })
      .catch(function (saveError) { setError(saveError.message); setSaving(false); });
  }

  return e("form", { className: "alert-composer card", style: popoverStyle(draft.rect, 340), onSubmit: save, onMouseDown: function (event) { event.stopPropagation(); } },
    e("div", { className: "panel-head" }, e("h2", null, e(BellIcon, { size: 16 }), " New alert"), e("button", { type: "button", className: "ghost", onClick: props.onClose }, "Cancel")),
    e("label", { className: "field" }, e("span", null, "Get news about"),
      e("input", { type: "text", value: query, autoFocus: true, maxLength: 300, onChange: function (event) { setQuery(event.target.value); } })),
    e("label", { className: "field" }, e("span", null, "Check"),
      e("select", { value: cadence, onChange: function (event) { setCadence(event.target.value); } },
        Object.keys(props.cadences).map(function (key) { return e("option", { key: key, value: key }, props.cadences[key]); }))),
    e("p", { className: "hint", style: { marginTop: 8 } }, "Each check is a web search, about $0.002. The first check runs right away."),
    error ? e("div", { className: "error", role: "alert" }, error) : null,
    e("div", { className: "actions" }, e("button", { type: "submit", disabled: saving || query.trim().length < 2 }, saving ? "Subscribing…" : "Subscribe"))
  );
}

function SelectionBell(props) {
  const [spot, setSpot] = useState(null);
  useEffect(function () {
    function check(event) {
      if (event && event.target && event.target.closest && event.target.closest(".selection-bell, .alert-composer")) return;
      setTimeout(function () {
        const selection = window.getSelection();
        const text = selection ? selection.toString().replace(/\\s+/g, " ").trim() : "";
        if (!text || text.length < 2 || text.length > 200 || !selection.rangeCount) { setSpot(null); return; }
        const node = selection.anchorNode && (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement);
        if (node && node.closest && node.closest("input, textarea, select, .alert-composer")) { setSpot(null); return; }
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (!rect.width && !rect.height) { setSpot(null); return; }
        setSpot({ text: text, rect: rect });
      }, 0);
    }
    function hide() { setSpot(null); }
    document.addEventListener("mouseup", check);
    document.addEventListener("keyup", check);
    window.addEventListener("scroll", hide, true);
    return function () {
      document.removeEventListener("mouseup", check);
      document.removeEventListener("keyup", check);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);
  if (!spot) return null;
  return e("button", {
    type: "button",
    className: "selection-bell",
    title: "Get news alerts about “" + spot.text + "”",
    "aria-label": "Get news alerts about the selected text",
    style: { left: Math.min(window.innerWidth - 44, spot.rect.right + 6), top: Math.max(8, spot.rect.top - 36) },
    onMouseDown: function (event) { event.preventDefault(); },
    onClick: function () { props.onAlert(spot.text, "selection", spot.rect); setSpot(null); }
  }, e(BellIcon, { size: 16 }));
}

const SOURCE_LABEL = { manual: "Added here", result: "From a search result", selection: "From selected text" };

function Alerts(props) {
  const state = props.state;
  const [query, setQuery] = useState("");
  const [cadence, setCadence] = useState("1d");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [news, setNews] = useState([]);
  const [busy, setBusy] = useState("");

  function loadNews() {
    api("/api/alerts/news" + (filter ? "?alertId=" + encodeURIComponent(filter) : ""))
      .then(function (body) { setNews(body.news); })
      .catch(function (newsError) { setError(newsError.message); });
  }
  useEffect(function () { if (props.active) loadNews(); }, [props.active, filter, state.unread, state.alerts.length]);

  function add(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    api("/api/alerts", { method: "POST", json: { query: query, cadence: cadence, source: "manual" } })
      .then(function (alert) { setQuery(""); props.log("info", "Alert created", { query: alert.query, cadence: alert.cadence }); props.reload(); })
      .catch(function (addError) { setError(addError.message); })
      .then(function () { setSaving(false); });
  }

  function act(alert, label, request) {
    setBusy(alert.id + label);
    setError("");
    request.then(function () { props.log("info", "Alert " + label, { query: alert.query }); props.reload(); })
      .catch(function (actError) { setError(actError.message); })
      .then(function () { setBusy(""); });
  }

  function markRead() {
    api("/api/alerts/news/read", { method: "POST", json: filter ? { alertId: filter } : {} }).then(function () { props.reload(); loadNews(); });
  }

  const selectedAlert = state.alerts.find(function (alert) { return alert.id === filter; });
  const queryOf = {};
  state.alerts.forEach(function (alert) { queryOf[alert.id] = alert.query; });

  return e("div", { className: "alerts" },
    e("section", { className: "card" },
      e("div", { className: "panel-head" },
        e("h2", null, "New alert"),
        e("span", { className: "muted small-text" }, "Follow a person, company, or topic. Kauntact checks the web on a schedule and new articles land in the feed below.")
      ),
      e("form", { className: "alert-form", onSubmit: add },
        e("input", { type: "text", value: query, maxLength: 300, placeholder: "e.g. Tyler Bryson Stripe, Snowflake, AI sales agents", onChange: function (event) { setQuery(event.target.value); }, "aria-label": "Alert topic" }),
        e("select", { value: cadence, onChange: function (event) { setCadence(event.target.value); }, "aria-label": "How often" },
          Object.keys(state.cadences).map(function (key) { return e("option", { key: key, value: key }, state.cadences[key]); })),
        e("button", { type: "submit", disabled: saving || query.trim().length < 2 }, saving ? "Adding…" : "Add alert")
      ),
      e("p", { className: "hint" }, "Each check is a web search, about $0.002, so a daily alert costs about $0.06 a month. You can also click a bell next to a name in a search result, or select any text on the page and click the bell that appears."),
      error || state.error ? e("div", { className: "error", role: "alert" }, error || state.error) : null
    ),
    e("div", { className: "alerts-grid" },
      e("section", { className: "card" },
        e("div", { className: "panel-head" }, e("h2", null, "Your alerts"), e("span", { className: "muted small-text" }, state.alerts.length + " total")),
        state.alerts.length ? e("ul", { className: "alert-list" }, state.alerts.map(function (alert) {
          const paused = alert.status === "paused";
          return e("li", { key: alert.id, className: filter === alert.id ? "selected" : "" },
            e("button", { type: "button", className: "alert-name", onClick: function () { setFilter(filter === alert.id ? "" : alert.id); } },
              e("b", null, alert.query),
              alert.unread ? e("span", { className: "count" }, alert.unread) : null
            ),
            e("div", { className: "muted small-text" },
              (state.cadences[alert.cadence] || alert.cadence) + " · " + (SOURCE_LABEL[alert.source] || alert.source) +
              (alert.lastRunAt ? " · last checked " + timeAgo(alert.lastRunAt) : " · first check pending")),
            alert.lastError ? e("div", { className: "bad small-text" }, "Last check failed: " + alert.lastError) : null,
            e("div", { className: "alert-actions" },
              e("span", { className: "pill " + (paused ? "running" : "pass") }, paused ? "Paused" : "Active"),
              e("button", { type: "button", className: "link", disabled: busy === alert.id + "checked", onClick: function () { act(alert, "checked", api("/api/alerts/" + alert.id + "/check", { method: "POST" })); } }, "Check now"),
              e("button", { type: "button", className: "link", onClick: function () { act(alert, paused ? "resumed" : "paused", api("/api/alerts/" + alert.id, { method: "PATCH", json: { status: paused ? "active" : "paused" } })); } }, paused ? "Resume" : "Pause"),
              e("select", { value: alert.cadence, "aria-label": "How often", onChange: function (event) { act(alert, "rescheduled", api("/api/alerts/" + alert.id, { method: "PATCH", json: { cadence: event.target.value } })); } },
                Object.keys(state.cadences).map(function (key) { return e("option", { key: key, value: key }, state.cadences[key]); })),
              e("button", { type: "button", className: "link danger", onClick: function () {
                if (window.confirm("Delete the alert for “" + alert.query + "” and its news?")) {
                  if (filter === alert.id) setFilter("");
                  act(alert, "deleted", api("/api/alerts/" + alert.id, { method: "DELETE" }));
                }
              } }, "Delete")
            )
          );
        })) : e("p", { className: "muted" }, "No alerts yet.")
      ),
      e("section", { className: "card" },
        e("div", { className: "panel-head" },
          e("h2", null, selectedAlert ? "News: " + selectedAlert.query : "News"),
          e("div", { className: "head-actions" },
            filter ? e("button", { type: "button", className: "ghost", onClick: function () { setFilter(""); } }, "All alerts") : null,
            e("button", { type: "button", className: "ghost", disabled: !news.some(function (item) { return !item.read; }), onClick: markRead }, "Mark all read")
          )
        ),
        selectedAlert && selectedAlert.lastSummary ? e("p", { className: "news-summary" }, selectedAlert.lastSummary) : null,
        news.length ? e("ul", { className: "news" }, news.map(function (item) {
          return e("li", { key: item.id, className: item.read ? "" : "unread" },
            e("div", { className: "news-meta" },
              item.read ? null : e("span", { className: "dot", title: "Unread" }),
              e("span", null, hostOf(item.url)),
              item.publishedDate ? e("span", null, formatDate(String(item.publishedDate).slice(0, 10))) : null,
              filter ? null : e("span", { className: "news-query" }, queryOf[item.alertId] || item.query)
            ),
            e("a", { href: item.url, target: "_blank", rel: "noreferrer", className: "news-title" }, item.title),
            item.snippet ? e("p", { className: "muted small-text" }, item.snippet) : null
          );
        })) : e("p", { className: "muted" }, state.alerts.length ? "No news yet. New articles appear here after each check." : "Add an alert to start receiving news.")
      )
    )
  );
}

function History(props) {
  if (!props.items.length) return null;
  return e("section", { className: "card history-card" },
    e("div", { className: "panel-head" }, e("h2", null, "History"), e("span", { className: "muted small-text" }, "Shared with everyone")),
    e("ul", { className: "history-list" }, props.items.map(function (item) {
      const label = item.type === "batch"
        ? item.fileName + " · " + item.rowCount + " rows"
        : (item.input && (item.input.accountName || item.input.domain)) || "Search";
      const detail = item.type === "batch"
        ? "CSV batch"
        : item.result ? (item.result.person_name || (item.result.verdict === "ready" ? "Ready" : "Cannot verify")) : "";
      return e("li", { key: item.type + item.id },
        e("button", { type: "button", className: "history-item", disabled: props.disabled, onClick: function () { props.onOpen(item); } },
          e("span", { className: "history-kind " + item.type }, item.type === "batch" ? "CSV" : "1"),
          e("span", { className: "history-label" }, e("b", null, label), detail ? e("small", { className: "muted block" }, detail) : null),
          e("span", { className: "muted small-text" }, timeAgo(item.createdAt))
        )
      );
    }))
  );
}

${scoutClientJs()}

function App() {
  const [logs, setLogs] = useState([]);

  function log(level, message, details) {
    const entry = { time: new Date().toISOString(), source: "ui", level: level, message: message, details: details };
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    console[method]("[ui] " + message, details === undefined ? "" : details);
    setLogs(function (current) { return current.concat([entry]); });
  }
  debugSink = log;

  function addServerLog(entry) {
    console.log("[server " + (entry.scope || "") + "] " + entry.message, entry.details === undefined ? "" : entry.details);
    setLogs(function (current) { return current.concat([entry]); });
  }

  const [accountName, setAccountName] = useState("");
  const [domain, setDomain] = useState("");
  const [persona, setPersona] = useState("");
  const [personName, setPersonName] = useState("");
  const [exclusion, setExclusion] = useState("");
  const [effort, setEffort] = useState("low");
  const [findEmail, setFindEmail] = useState(false);
  const [started, setStarted] = useState(false);
  const [account, setAccount] = useState(null);
  const [sessionCost, setSessionCost] = useState({ exa: 0, tavily: 0, llm: 0 });

  function recordSpend(parts) {
    const exa = Number(parts && parts.exa) || 0;
    const tavily = Number(parts && parts.tavily) || 0;
    const llm = Number(parts && parts.llm) || 0;
    if (!exa && !tavily && !llm) return;
    setSessionCost(function (current) {
      return { exa: current.exa + exa, tavily: current.tavily + tavily, llm: current.llm + llm };
    });
  }

  function tabFromHash() {
    const tabs = { "#evals": "evals", "#scout": "scout", "#scout-evals": "scout-evals", "#alerts": "alerts" };
    return tabs[location.hash] || "search";
  }
  const [tab, setTab] = useState(tabFromHash);
  useEffect(function () {
    function onHash() { setTab(tabFromHash()); }
    window.addEventListener("hashchange", onHash);
    return function () { window.removeEventListener("hashchange", onHash); };
  }, []);

  const [alertsState, setAlertsState] = useState({ alerts: [], unread: 0, cadences: { "12h": "Every 12 hours", "1d": "Daily", "7d": "Weekly" }, error: "" });
  const [composer, setComposer] = useState(null);
  const [toast, setToast] = useState("");
  function loadAlerts() {
    return api("/api/alerts")
      .then(function (body) { setAlertsState({ alerts: body.alerts, unread: body.unread, cadences: body.cadences, error: "" }); })
      .catch(function (alertsError) { setAlertsState(function (current) { return Object.assign({}, current, { error: alertsError.message }); }); });
  }
  useEffect(function () {
    loadAlerts();
    const timer = setInterval(function () { if (!document.hidden) loadAlerts(); }, 60000);
    return function () { clearInterval(timer); };
  }, []);
  useEffect(function () {
    if (!toast) return;
    const timer = setTimeout(function () { setToast(""); }, 4000);
    return function () { clearTimeout(timer); };
  }, [toast]);
  function openComposer(query, source, rect) {
    setComposer({ query: query, source: source, rect: rect });
  }
  function alertSaved(alert) {
    setComposer(null);
    setToast("Alert added for “" + alert.query + "”. News will show in the Alerts tab.");
    log("info", "Alert created", { query: alert.query, cadence: alert.cadence, source: alert.source });
    loadAlerts();
  }

  const [history, setHistory] = useState([]);
  function loadHistory() {
    return api("/api/history").then(function (body) { setHistory(body.items); }).catch(function (historyError) {
      log("warn", "Could not load history", { message: historyError.message });
    });
  }
  useEffect(function () { loadHistory(); }, []);

  function loadAccount(reason) {
    return fetch("/api/account")
      .then(function (response) { return response.json(); })
      .then(function (data) {
        setAccount(data);
        log("info", "Account refreshed (" + reason + ")", { username: data.username, balance: data.balance });
      })
      .catch(function (accountError) {
        log("warn", "Could not load account", { message: accountError.message });
      });
  }

  useEffect(function () { loadAccount("page load"); }, []);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [traces, setTraces] = useState([]);
  const [result, setResult] = useState(null);

  async function onSubmit(event) {
    event.preventDefault();
    setError("");
    setResult(null);
    setTraces([]);
    setStatus("");
    const payload = {
      accountName: accountName,
      domain: domain,
      persona: persona,
      personName: personName,
      exclusion: exclusion,
      effort: effort,
      findEmail: findEmail
    };
    log("info", "Find signal clicked", payload);
    if (!accountName.trim() && !domain.trim()) {
      log("warn", "Validation failed: account name and domain are both empty");
      setError("At least one of account name or domain must be provided.");
      return;
    }
    setStarted(true);
    setLoading(true);
    setStatus("Searching public signals…");
    const started = Date.now();
    let eventCount = 0;
    try {
      log("info", "POST /api/runs sent");
      const outcome = await streamRun(payload, {
        onHeaders: function (response, type) {
          log("info", "Response headers received", { status: response.status, contentType: type, afterMs: Date.now() - started });
        },
        onEvent: function (message) {
          eventCount += 1;
          if (message.event !== "log") log("debug", "Stream event: " + message.event, message.data);
        },
        onLog: addServerLog,
        onStatus: function (message) { setStatus(message || "Searching public signals…"); },
        onTrace: function (trace) {
          setTraces(function (current) {
            const next = current.slice();
            const index = next.findIndex(function (item) { return item.callId === trace.callId; });
            if (index === -1) next.push(Object.assign({ seenAt: new Date().toTimeString().slice(0, 8) }, trace));
            else next[index] = Object.assign({}, next[index], trace);
            return next;
          });
        }
      });
      log("info", "Run finished", { events: eventCount, afterMs: Date.now() - started });
      if (outcome.result) {
        setResult(outcome.result);
        recordSpend({ exa: outcome.result.costDollars && outcome.result.costDollars.total });
      } else {
        log("error", "Run failed", { message: outcome.error });
        setError(outcome.error);
      }
    } catch (requestError) {
      log("error", "Request failed", { name: requestError.name, message: requestError.message });
      setError(requestError.message || "The run failed.");
    } finally {
      setLoading(false);
      loadAccount("after search");
      loadHistory();
    }
  }

  const [mode, setMode] = useState("single");
  const [csv, setCsv] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const stopRef = useRef(null);
  const validRows = csv && csv.rows ? csv.rows.filter(function (cells) { const input = inputFromRow(csv, cells); return input.accountName || input.domain; }).length : 0;
  const perRowMax = maxCostFor(effort) + (findEmail ? EMAIL_ENRICHMENT_PRICE : 0);

  function onFile(event) {
    const file = event.target.files && event.target.files[0];
    setJobs([]);
    if (!file) { setCsv(null); return; }
    file.text().then(function (text) {
      const parsed = readCsvFile(file.name, text);
      setCsv(parsed);
      log(parsed.error ? "warn" : "info", "CSV loaded", parsed.error ? { file: file.name, error: parsed.error } : { file: file.name, rows: parsed.rows.length, columns: parsed.headers });
    });
  }

  function updateJob(index, patch) {
    setJobs(function (current) {
      const next = current.slice();
      next[index] = Object.assign({}, next[index], patch);
      return next;
    });
  }

  async function runBatch(event) {
    event.preventDefault();
    setError("");
    if (!csv || csv.error || !validRows) return;
    const maxCost = validRows * perRowMax;
    if (!window.confirm("Run " + validRows + " searches at " + effortById(effort).label + " effort" + (findEmail ? " with email lookup" : "") + "? Each row is a paid search. Maximum cost: " + balanceMoney(maxCost) + ".")) return;
    const initial = csv.rows.map(function (cells) {
      const input = inputFromRow(csv, cells);
      return input.accountName || input.domain
        ? { cells: cells, input: input, status: "queued" }
        : { cells: cells, input: input, status: "skipped", error: "Needs an account name or a domain" };
    });
    const controller = new AbortController();
    stopRef.current = controller;
    setJobs(initial);
    setStarted(true);
    setBatchRunning(true);
    let batchId = null;
    try {
      batchId = (await api("/api/batches", { method: "POST", json: { fileName: csv.fileName, headers: csv.headers, mapping: csv.mapping, rows: csv.rows, effort: effort, findEmail: findEmail } })).id;
    } catch (saveError) {
      log("warn", "Could not save the batch to MongoDB; running without history", { message: saveError.message });
    }
    log("info", "CSV batch started", { file: csv.fileName, rows: validRows, effort: effort, findEmail: findEmail, concurrency: BATCH_CONCURRENCY, batchId: batchId });
    const queue = initial.map(function (job, index) { return index; }).filter(function (index) { return initial[index].status === "queued"; });
    let next = 0;
    async function worker() {
      while (next < queue.length) {
        const index = queue[next++];
        if (controller.signal.aborted) {
          updateJob(index, { status: "skipped", error: "Stopped before this row ran" });
          continue;
        }
        updateJob(index, { status: "running" });
        try {
          const outcome = await streamRun(Object.assign({}, initial[index].input, { effort: effort, findEmail: findEmail, batchId: batchId, rowIndex: index }), { onLog: addServerLog }, controller.signal);
          if (outcome.result) {
            recordSpend({ exa: outcome.result.costDollars && outcome.result.costDollars.total });
            updateJob(index, { status: "done", result: outcome.result });
          } else {
            updateJob(index, { status: "error", error: outcome.error });
          }
        } catch (rowError) {
          updateJob(index, { status: controller.signal.aborted ? "skipped" : "error", error: controller.signal.aborted ? "Stopped while running" : rowError.message });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, worker));
    setBatchRunning(false);
    log("info", "CSV batch finished", { file: csv.fileName, stopped: controller.signal.aborted });
    loadAccount("after batch");
    loadHistory();
  }

  function openHistory(item) {
    setError("");
    if (item.type === "search") {
      api("/api/searches/" + item.id).then(function (search) {
        const input = search.input || {};
        setMode("single");
        setAccountName(input.accountName || "");
        setDomain(input.domain || "");
        setPersona(input.persona || "");
        setPersonName(input.personName || "");
        setExclusion(input.exclusion || "");
        if (input.effort) setEffort(input.effort);
        setFindEmail(Boolean(input.findEmail));
        setTraces(search.traces || []);
        setResult(search.result || null);
        if (!search.result) setError(search.error || "This search did not finish.");
        setStarted(true);
        log("info", "Reopened a saved search", { id: search.id, account: input.accountName || input.domain });
      }).catch(function (openError) { setError(openError.message); });
      return;
    }
    api("/api/batches/" + item.id).then(function (batch) {
      const parsed = { fileName: batch.fileName, headers: batch.headers, mapping: batch.mapping, rows: batch.rows };
      const byRow = {};
      batch.searches.forEach(function (search) { byRow[search.rowIndex] = search; });
      setMode("csv");
      if (batch.effort) setEffort(batch.effort);
      setFindEmail(Boolean(batch.findEmail));
      setCsv(parsed);
      setJobs(batch.rows.map(function (cells, index) {
        const input = inputFromRow(parsed, cells);
        const search = byRow[index];
        if (search && search.result) return { cells: cells, input: input, status: "done", result: search.result };
        if (search) return { cells: cells, input: input, status: "error", error: search.error || "Failed" };
        return { cells: cells, input: input, status: "skipped", error: input.accountName || input.domain ? "Did not run" : "Needs an account name or a domain" };
      }));
      setStarted(true);
      log("info", "Reopened a saved CSV batch", { id: batch.id, file: batch.fileName, rows: batch.rows.length });
    }).catch(function (openError) { setError(openError.message); });
  }

  function stopBatch() {
    if (stopRef.current) stopRef.current.abort();
    log("warn", "CSV batch stopped by user");
  }

  function downloadBatch() {
    downloadText(csv.fileName.replace(/\\.csv$/i, "") + "-kauntact.csv", buildOutputCsv(csv, jobs));
    log("info", "CSV downloaded", { rows: jobs.length });
  }

  const busy = loading || batchRunning;
  const showBatch = mode === "csv" && jobs.length > 0;
  const liveTraces = mode === "single" && loading;

  return e("div", null,
    e("header", { className: "top" },
      e("div", { className: "brand" },
        e("img", { src: "/favicon.svg", alt: "" }),
        e("div", { className: "brand-text" },
          e("h1", null, "Delulu AI Labs"),
          e("em", { className: "motto" }, "Delulu is the solulu")
        )
      ),
      e(Account, { account: account, cost: sessionCost })
    ),
    e("nav", { className: "tabs" },
      e("a", { href: "#search", className: tab === "search" ? "active" : "" }, "Kauntact"),
      e("a", { href: "#evals", className: tab === "evals" ? "active" : "" }, "Kauntact Evals"),
      e("a", { href: "#scout", className: tab === "scout" ? "active" : "" }, "Scout"),
      e("a", { href: "#scout-evals", className: tab === "scout-evals" ? "active" : "" }, "Scout Evals"),
      e("a", { href: "#alerts", className: tab === "alerts" ? "active" : "" }, "Alerts",
        alertsState.unread ? e("span", { className: "count", "aria-label": alertsState.unread + " unread" }, alertsState.unread > 99 ? "99+" : alertsState.unread) : null)
    ),
    e("div", { hidden: tab !== "alerts" },
      e(Alerts, { active: tab === "alerts", state: alertsState, reload: loadAlerts, log: log })
    ),
    e("div", { hidden: tab !== "scout" },
      e(Scout, { log: log, onSpend: recordSpend })
    ),
    e("div", { hidden: tab !== "scout-evals" },
      e(ScoutEvals, {
        log: log,
        addServerLog: addServerLog,
        onSpend: recordSpend,
        onFinished: function () { loadAccount("after Scout evals"); }
      })
    ),
    e("div", { hidden: tab !== "evals" },
      e(Evals, {
        log: log,
        addServerLog: addServerLog,
        onSpend: recordSpend,
        onFinished: function () { loadAccount("after evals"); }
      })
    ),
    e("div", { hidden: tab !== "search" },
    e("div", { className: "workspace " + (started ? "split" : "idle") },
      e("div", { className: "left" },
      e("form", { className: "card", onSubmit: mode === "single" ? onSubmit : runBatch },
        e("div", { className: "mode-switch", role: "tablist" },
          [["single", "One opener"], ["csv", "Upload CSV"]].map(function (option) {
            return e("button", {
              key: option[0],
              type: "button",
              role: "tab",
              "aria-selected": mode === option[0],
              className: mode === option[0] ? "active" : "",
              disabled: busy,
              onClick: function () { setMode(option[0]); setError(""); }
            }, option[1]);
          })
        ),
        e("div", { className: "grid" },
          mode === "single" ? [
            e(Field, { key: "accountName", id: "accountName", label: "Account name", value: accountName, onChange: setAccountName, placeholder: "Acme" }),
            e(Field, { key: "domain", id: "domain", label: "Domain name", value: domain, onChange: setDomain, placeholder: "acme.com" }),
            e(Field, { key: "persona", id: "persona", label: "Persona", value: persona, onChange: setPersona, placeholder: "Optional" }),
            e(Field, { key: "personName", id: "personName", label: "Person name", value: personName, onChange: setPersonName, placeholder: "Optional" }),
            e(Field, { key: "exclusion", id: "exclusion", label: "Exclusion rules", value: exclusion, onChange: setExclusion, placeholder: "Optional event to leave out", wide: true, multiline: true })
          ] : e("div", { className: "field wide csv-input" },
            e("label", { className: "label", htmlFor: "csvFile" }, "CSV file"),
            e("input", { id: "csvFile", type: "file", accept: ".csv,text/csv", disabled: busy, onChange: onFile }),
            e("p", { className: "hint", style: { marginTop: 2 } },
              "Columns: account name, domain, persona, person, exclusion. Each row needs an account name or a domain. Up to " + MAX_BATCH_ROWS + " rows. ",
              e("button", { type: "button", className: "link", onClick: downloadTemplate }, "Download a template")
            ),
            csv && csv.error ? e("div", { className: "error", role: "alert" }, csv.error) : null,
            csv && csv.rows ? e("div", { className: "csv-summary" },
              e("div", null, e("b", null, csv.fileName), " · " + csv.rows.length + " row" + (csv.rows.length === 1 ? "" : "s")),
              e("div", { className: "muted small-text" }, "Reading " + Object.keys(csv.mapping).map(function (field) {
                return INPUT_LABELS[field] + " from “" + csv.headers[csv.mapping[field]] + "”";
              }).join(", ") + "."),
              csv.rows.length - validRows ? e("div", { className: "muted small-text" }, (csv.rows.length - validRows) + " row(s) have no account name or domain and will be skipped.") : null
            ) : null
          ),
          e(Effort, { value: effort, onChange: setEffort }),
          e("label", { className: "field wide check" },
            e("input", { type: "checkbox", checked: findEmail, onChange: function (event) { setFindEmail(event.target.checked); } }),
            e("span", null, "Get the recipient's email address",
              e("small", null, "Costs a little extra: up to " + money(EMAIL_ENRICHMENT_PRICE) + " more if an email lookup is needed to find the address."))
          )
        ),
        mode === "single" ? e("p", { className: "hint" }, "Provide an account name or a domain name. Everything else is optional.") : null,
        e("div", { className: "actions" },
          mode === "single"
            ? e("button", { type: "submit", disabled: busy }, loading ? "Searching…" : "Find signal")
            : e("button", { type: "submit", disabled: busy || !validRows },
                batchRunning ? "Running…" : "Run " + validRows + " row" + (validRows === 1 ? "" : "s") + (validRows ? " · up to " + balanceMoney(validRows * perRowMax) : "")),
          mode === "single" ? e(CostEstimate, { effort: effort, findEmail: findEmail }) : e("span", { className: "estimate" }, BATCH_CONCURRENCY + " rows run at a time.")
        ),
        error ? e("div", { className: "error", role: "alert" }, error) : null
      ),
      e(History, { items: history, disabled: busy, onOpen: openHistory })
      ),
      started
        ? e("div", { className: "side" },
            showBatch
              ? e(BatchProgress, { fileName: csv.fileName, jobs: jobs, running: batchRunning, onStop: stopBatch, onDownload: downloadBatch, onAlert: openComposer })
              : mode === "single"
                ? (result ? e(Result, { result: result, onAlert: openComposer }) : loading ? [e(Pending, { key: "pending", status: status }), e(Traces, { key: "traces", traces: traces, live: true })] : null)
                : null
          )
        : null
    ),
    e("div", { className: "panels" + (liveTraces || mode === "csv" ? " single" : "") },
      liveTraces || mode === "csv" ? null : e(Traces, { traces: traces }),
      e(DebugLog, { logs: logs, onClear: function () { setLogs([]); } })
    )
    ),
    tab !== "search" ? e("div", { className: "panels single" },
      e(DebugLog, { logs: logs, onClear: function () { setLogs([]); } })
    ) : null,
    e(SelectionBell, { onAlert: openComposer }),
    composer ? e(AlertComposer, { key: composer.query + composer.rect.top, draft: composer, cadences: alertsState.cadences, onClose: function () { setComposer(null); }, onSaved: alertSaved }) : null,
    toast ? e("div", { className: "toast", role: "status" }, toast) : null
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(e(App));
`;
}

function credentialsFrom(req) {
  const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
  if (scheme !== "Basic" || !encoded) return { username: "", password: "" };
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon === -1) return { username: decoded, password: "" };
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

// The regular EXA_API_KEY is rejected here; this endpoint needs a team service key.
async function fetchBalance() {
  const key = process.env.EXA_SERVICE_KEY;
  if (!key) {
    return { available: false, reason: "Exa only reports the balance to a team service key. Set EXA_SERVICE_KEY to show it." };
  }
  try {
    const response = await fetch("https://admin-api.exa.ai/team-management/credits", {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { available: false, reason: `Exa balance request failed (${response.status}${body.error ? `: ${body.error}` : ""}).` };
    }
    return {
      available: true,
      creditsUsd: body.credits_usd,
      generatedAt: body.metadata?.generated_at ?? new Date().toISOString(),
    };
  } catch (error) {
    return { available: false, reason: `Exa balance request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// When APP_PASSWORD is unset (local dev), the app is open.
function requirePassword(req, res, next) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return next();
  const supplied = credentialsFrom(req).password;
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  if (timingSafeEqual(a, b)) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="Kauntact", charset="UTF-8"');
  res.status(401).send("Password required");
}

const CADENCES = { "12h": "Every 12 hours", "1d": "Daily", "7d": "Weekly" };
const ALERT_SOURCES = ["manual", "result", "selection"];
const PRODUCTION_URL = "https://kauntact.vercel.app";

// Local and hosted share one database, so monitors created locally still deliver to the hosted webhook.
function publicBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return PRODUCTION_URL;
}

function verifyExaSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 900) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"), "hex");
  return signatures.some((signature) => {
    const actual = Buffer.from(signature, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

function newsItemFrom(result, alert, runId) {
  const title = result.title || result.url;
  let snippet = String((Array.isArray(result.highlights) && result.highlights.join(" … ")) || result.summary || String(result.text ?? "").slice(0, 800))
    .replace(/[#*_>`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  while (title && snippet.toLowerCase().startsWith(title.toLowerCase())) snippet = snippet.slice(title.length).replace(/^[\s|:–-]+/, "");
  return {
    alertId: alert.id,
    query: alert.query,
    runId,
    url: result.url,
    title,
    publishedDate: result.publishedDate ?? null,
    author: result.author ?? null,
    snippet: snippet ? snippet.slice(0, 600) : null,
    image: result.image ?? null,
    favicon: result.favicon ?? null,
  };
}

// Monitors only return very recent pages; a bare name like "Snowflake" matched nothing, while a news-phrased query did.
function monitorQueryFor(query) {
  return `latest news about ${query}`;
}

function publicAlert(alert) {
  if (!alert) return alert;
  const { webhookSecret, ...rest } = alert;
  return rest;
}

// The UI never names the search or storage providers; the raw message still goes to the debug log.
function uiMessage(message) {
  return String(message)
    .replace(/\bMONGODB_URI\b/g, "the storage connection string")
    .replace(/\bmongo(db)?\b/gi, "storage")
    .replace(/\bEXA_[A-Z_]+\b/g, "the search API key")
    .replace(/\bexa(-js|\.ai)?\b/gi, "the search service")
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function route(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      const status = error?.statusCode ?? (typeof error?.status === "number" && error.status >= 400 && error.status < 500 ? error.status : 500);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${new Date().toISOString()}] [http] ${req.method} ${req.originalUrl} failed: ${message}`);
      if (!res.headersSent) res.status(status).json({ error: uiMessage(message), debug: message });
    });
  };
}

async function handleExaWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }
  const monitorId = event?.data?.monitorId ?? (String(event?.type ?? "").startsWith("monitor.run") ? null : event?.data?.id);
  const alert = monitorId ? await store.findAlertByMonitor(String(monitorId)) : null;
  if (!alert || !verifyExaSignature(raw, req.get("exa-signature"), alert.webhookSecret)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }
  if (event.type === "monitor.run.completed") {
    const data = event.data ?? {};
    if (data.status === "completed") {
      let output = data.output;
      if (!output) output = (await new Exa().monitors.runs.get(alert.monitorId, data.id)).output;
      const results = Array.isArray(output?.results) ? output.results.filter((result) => typeof result?.url === "string") : [];
      const added = await store.insertNews(results.map((result) => newsItemFrom(result, alert, data.id)));
      await store.updateAlert(alert.id, {
        lastRunAt: new Date(),
        lastRunNew: added,
        lastSummary: typeof output?.content === "string" ? output.content.slice(0, 2000) : null,
        lastError: null,
      });
      console.error(`[${new Date().toISOString()}] [webhook] alert ${alert.id} run ${data.id}: ${results.length} results, ${added} new`);
    } else {
      console.error(`[${new Date().toISOString()}] [webhook] alert ${alert.id} run ${data.id} failed: ${data.failReason ?? data.status}`);
      await store.updateAlert(alert.id, { lastRunAt: new Date(), lastError: uiMessage(data.failReason ?? data.status ?? "run failed") });
    }
  }
  res.json({ ok: true });
}

function inputOf(fields) {
  const { accountName, domain, persona, personName, exclusion, effort, findEmail } = fields;
  return { accountName, domain, persona, personName, exclusion, effort, findEmail };
}

async function saveSearchQuietly(doc, log) {
  if (!store.mongoConfigured()) return null;
  try {
    return await store.saveSearch(doc);
  } catch (error) {
    log("warn", "Could not save the search to MongoDB", errorDetails(error));
    return null;
  }
}

function createApp() {
  const app = express();
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      console.error(`[${new Date().toISOString()}] [http] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });
  // Exa cannot sign in, so the webhook sits outside the password and is verified by its HMAC signature instead.
  app.post("/api/webhooks/exa", express.raw({ type: () => true, limit: "5mb" }), route(handleExaWebhook));
  app.use(requirePassword);
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/state/balance", route(async (_req, res) => {
    res.json(await store.getBalance());
  }));
  app.put("/api/state/balance", route(async (req, res) => {
    const amount = Number(req.body?.amount);
    if (!(amount >= 0 && amount < 1e6)) {
      res.status(400).json({ error: "amount must be a non-negative number." });
      return;
    }
    res.json(await store.setBalance({ amount, userSet: req.body?.userSet === true }));
  }));
  app.post("/api/state/balance/spend", route(async (req, res) => {
    const cost = Number(req.body?.cost);
    if (!(cost > 0 && cost < 1000)) {
      res.status(400).json({ error: "cost must be a positive number." });
      return;
    }
    res.json(await store.spendBalance(cost));
  }));

  app.get("/api/history", route(async (_req, res) => {
    res.json({ items: await store.listHistory() });
  }));
  app.get("/api/searches/:id", route(async (req, res) => {
    const search = await store.getSearch(req.params.id);
    if (!search) res.status(404).json({ error: "Not found." });
    else res.json(search);
  }));
  app.post("/api/batches", route(async (req, res) => {
    const body = req.body ?? {};
    const headers = Array.isArray(body.headers) ? body.headers.map((value) => String(value).slice(0, 200)) : [];
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!headers.length || headers.length > 100 || !rows.length || rows.length > 50) {
      res.status(400).json({ error: "A batch needs 1-100 columns and 1-50 rows." });
      return;
    }
    const id = await store.createBatch({
      fileName: String(body.fileName ?? "batch.csv").slice(0, 200),
      headers,
      mapping: body.mapping && typeof body.mapping === "object" ? body.mapping : {},
      rows: rows.map((cells) => headers.map((_, index) => String(Array.isArray(cells) ? cells[index] ?? "" : "").slice(0, 5000))),
      rowCount: rows.length,
      effort: EFFORTS.includes(body.effort) ? body.effort : "low",
      findEmail: body.findEmail === true,
    });
    res.json({ id });
  }));
  app.get("/api/batches/:id", route(async (req, res) => {
    const batch = await store.getBatch(req.params.id);
    if (!batch) res.status(404).json({ error: "Not found." });
    else res.json(batch);
  }));

  app.get("/api/alerts", route(async (_req, res) => {
    const alerts = await store.listAlerts();
    res.json({ alerts, unread: alerts.reduce((sum, alert) => sum + alert.unread, 0), cadences: CADENCES, webhookUrl: `${publicBaseUrl()}/api/webhooks/exa` });
  }));
  app.post("/api/alerts", route(async (req, res) => {
    const query = clean(req.body?.query);
    const cadence = req.body?.cadence ?? "1d";
    const source = ALERT_SOURCES.includes(req.body?.source) ? req.body.source : "manual";
    if (query.length < 2 || query.length > 300) {
      res.status(400).json({ error: "The alert needs 2 to 300 characters of text." });
      return;
    }
    if (!CADENCES[cadence]) {
      res.status(400).json({ error: `cadence must be one of ${Object.keys(CADENCES).join(", ")}.` });
      return;
    }
    const webhookUrl = `${publicBaseUrl()}/api/webhooks/exa`;
    const id = await store.createAlert({ query, cadence, source, status: "creating", webhookUrl });
    let monitor;
    try {
      monitor = await new Exa().monitors.create({
        name: query.slice(0, 100),
        search: { query: monitorQueryFor(query), numResults: 10, contents: { highlights: true } },
        trigger: { type: "interval", period: cadence },
        webhook: { url: webhookUrl, events: ["monitor.run.completed"] },
        metadata: { alertId: id },
      });
    } catch (error) {
      await store.deleteAlert(id);
      throw error;
    }
    await store.updateAlert(id, { monitorId: monitor.id, webhookSecret: monitor.webhookSecret, status: monitor.status, nextRunAt: monitor.nextRunAt });
    new Exa().monitors.trigger(monitor.id).catch((error) => {
      console.error(`[${new Date().toISOString()}] [alerts] first run for ${monitor.id} did not start: ${error.message}`);
    });
    res.json(publicAlert(await store.getAlert(id)));
  }));
  app.patch("/api/alerts/:id", route(async (req, res) => {
    const alert = await store.getAlert(req.params.id);
    if (!alert) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    const changes = {};
    const update = {};
    if (req.body?.status !== undefined) {
      if (!["active", "paused"].includes(req.body.status)) {
        res.status(400).json({ error: "status must be active or paused." });
        return;
      }
      changes.status = update.status = req.body.status;
    }
    if (req.body?.cadence !== undefined) {
      if (!CADENCES[req.body.cadence]) {
        res.status(400).json({ error: `cadence must be one of ${Object.keys(CADENCES).join(", ")}.` });
        return;
      }
      changes.cadence = req.body.cadence;
      update.trigger = { type: "interval", period: req.body.cadence };
    }
    const monitor = await new Exa().monitors.update(alert.monitorId, update);
    await store.updateAlert(alert.id, { ...changes, nextRunAt: monitor.nextRunAt });
    res.json(publicAlert(await store.getAlert(alert.id)));
  }));
  app.post("/api/alerts/:id/check", route(async (req, res) => {
    const alert = await store.getAlert(req.params.id);
    if (!alert) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    await new Exa().monitors.trigger(alert.monitorId);
    res.json({ triggered: true });
  }));
  app.delete("/api/alerts/:id", route(async (req, res) => {
    const alert = await store.getAlert(req.params.id);
    if (!alert) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    if (alert.monitorId) {
      await new Exa().monitors.delete(alert.monitorId).catch((error) => {
        if (error?.statusCode !== 404 && error?.status !== 404) throw error;
      });
    }
    await store.deleteAlert(alert.id);
    res.json({ deleted: true });
  }));
  app.get("/api/alerts/news", route(async (req, res) => {
    const alertId = typeof req.query.alertId === "string" && req.query.alertId ? req.query.alertId : undefined;
    res.json({ news: await store.listNews({ alertId }) });
  }));
  app.post("/api/alerts/news/read", route(async (req, res) => {
    await store.markNewsRead({ alertId: typeof req.body?.alertId === "string" ? req.body.alertId : undefined });
    res.json({ ok: true });
  }));

  app.get("/vendor/react.js", (_req, res) => {
    res.sendFile(fileURLToPath(new URL("./node_modules/react/umd/react.development.js", import.meta.url)));
  });
  app.get("/vendor/react-dom.js", (_req, res) => {
    res.sendFile(fileURLToPath(new URL("./node_modules/react-dom/umd/react-dom.development.js", import.meta.url)));
  });
  app.get("/api/account", async (req, res) => {
    const balance = await fetchBalance();
    res.json({ username: credentialsFrom(req).username || null, balance });
  });
  app.get("/api/evals/cases", route(async (_req, res) => {
    const evals = await import("./evals.js");
    const cases = await evals.loadCases();
    res.json({
      cases: cases.map((caseDef) => ({
        ...caseDef,
        limits: Object.fromEntries(EFFORTS.map((effort) => [effort, evals.limitsFor(caseDef.expect, effort)])),
      })),
      window: signalWindow(),
      judge: {
        available: evals.judgeConfigured(),
        defaultModel: evals.DEFAULT_JUDGE_MODEL,
        models: evals.GRADER_MODELS,
        criteria: evals.JUDGE_CRITERIA.map(([, name, rule, summary]) => ({ name, rule, summary })),
      },
    });
  }));
  app.post("/api/evals/cases", route(async (req, res) => {
    const evals = await import("./evals.js");
    res.json(await store.createCase(evals.validateCase(req.body)));
  }));
  app.put("/api/evals/cases/:id", route(async (req, res) => {
    const evals = await import("./evals.js");
    const caseDef = evals.validateCase({ ...req.body, id: req.params.id });
    res.json(await store.updateCase(req.params.id, caseDef));
  }));
  app.delete("/api/evals/cases/:id", route(async (req, res) => {
    await store.deleteCase(req.params.id);
    res.json({ deleted: true });
  }));
  app.get("/api/evals/runs", route(async (_req, res) => {
    res.json({ runs: await store.listEvalRuns() });
  }));
  app.delete("/api/evals/runs", route(async (_req, res) => {
    await store.clearEvalRuns();
    res.json({ deleted: true });
  }));
  app.patch("/api/evals/runs/:id", route(async (req, res) => {
    if (typeof req.body?.name !== "string") {
      res.status(400).json({ error: "Send the new name as text. An empty name removes it." });
      return;
    }
    res.json(await store.renameEvalRun(req.params.id, req.body.name));
  }));

  app.post("/api/evals/self-test", async (_req, res) => {
    const evals = await import("./evals.js");
    res.json(evals.runSelfTests());
  });

  app.post("/api/evals/run", route(async (req, res) => {
    const evals = await import("./evals.js");
    const reqId = `evals-${++requestCounter}`;
    const body = req.body ?? {};
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const cases = await evals.loadCases();
    const unknown = ids.filter((id) => !cases.some((caseDef) => caseDef.id === id));
    if (!ids.length || unknown.length) {
      res.status(400).json({ error: ids.length ? `Unknown case id(s): ${unknown.join(", ")}` : "Select at least one case." });
      return;
    }
    if (!process.env.EXA_API_KEY) {
      res.status(500).json({ error: "The search API key is not set on the server." });
      return;
    }
    const effort = body.effort ?? "low";
    if (!EFFORTS.includes(effort)) {
      res.status(400).json({ error: `effort must be one of ${EFFORTS.join(", ")}` });
      return;
    }
    const judgeModel = body.judgeModel ?? evals.DEFAULT_JUDGE_MODEL;
    if (!evals.GRADER_MODELS.some((model) => model.id === judgeModel)) {
      res.status(400).json({ error: "judgeModel must be a Grove chat model id from the catalog." });
      return;
    }
    const concurrency = Math.min(3, Math.max(1, Number(body.concurrency) || 2));
    const sources = body.sources !== false;
    const judge = body.judge !== false;
    const name = store.cleanRunName(body.name);
    const selected = cases.filter((caseDef) => ids.includes(caseDef.id));

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    const log = createLogger(reqId, (entry) => {
      if (entry.level !== "debug") writeSse(res, "log", entry);
    });
    const abort = new AbortController();
    let finished = false;
    res.on("close", () => {
      if (!finished) {
        log("warn", "Browser closed the connection; aborting remaining eval cases");
        abort.abort();
      }
    });

    const window = signalWindow();
    log("info", "Eval run started", { name, ids, effort, concurrency, sources, judge, judgeModel: judge ? judgeModel : null });
    writeSse(res, "start", { name, ids, effort, concurrency, sources, judge, judgeModel: judge ? judgeModel : null, window });
    try {
      const results = await evals.pool(selected, concurrency, async (caseDef) => {
        if (abort.signal.aborted) return null;
        writeSse(res, "case-start", { id: caseDef.id });
        const result = await evals.runCase(caseDef, { effort, sources, judge, judgeModel, signal: abort.signal, log });
        log(result.passed ? "info" : "warn", `Case ${caseDef.id} ${result.passed ? "passed" : "failed"}`, { cost: result.cost, latencyMs: result.latencyMs });
        if (result.error) {
          log("error", `Case ${result.id} failed`, { message: result.error });
          result.error = uiMessage(result.error);
        }
        writeSse(res, "case-result", result);
        return result;
      });
      const completed = results.filter(Boolean);
      const summary = evals.summarize(completed);
      log("info", "Eval run finished", { passed: summary.passedCases, total: summary.totalCases, cost: summary.cost });
      const done = { ...summary, name, effort, judgeModel: judge ? judgeModel : null, window };
      let runId = null;
      try {
        runId = await store.saveEvalRun({
          name,
          source: "ui",
          effort,
          judgeModel: done.judgeModel,
          sources,
          passed: summary.passedCases,
          total: summary.totalCases,
          cost: summary.cost,
          summary: done,
          results: completed,
        });
      } catch (saveError) {
        log("warn", "Could not save the eval run to MongoDB", errorDetails(saveError));
      }
      writeSse(res, "done", { ...done, runId });
    } catch (error) {
      log("error", "Eval run failed", errorDetails(error));
      writeSse(res, "error", { error: uiMessage(error instanceof Error ? error.message : String(error)) });
    } finally {
      await flushApiLogs();
      finished = true;
      res.end();
    }
  }));

  app.get("/api/scout/config", route(async (_req, res) => {
    const scout = await import("./scout.js");
    res.json(scout.scoutConfig());
  }));
  app.post("/api/scout/search", route(async (req, res) => {
    const scout = await import("./scout.js");
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    const search = await withApiContext({ surface: "scout-search" }, () => scout.scoutSearch(req.body, abort.signal));
    for (const run of Object.values(search.runs)) {
      if (run.error) {
        console.error(`[${new Date().toISOString()}] [scout] ${run.provider} failed: ${run.error}`);
        run.debug = run.error;
        run.error = uiMessage(run.error);
      }
    }
    let id = null;
    if (store.mongoConfigured()) {
      try {
        id = await store.saveScoutSearch(search);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] [scout] could not save the search: ${error.message}`);
      }
    }
    res.json({ ...search, id });
  }));
  app.get("/api/scout/history", route(async (_req, res) => {
    res.json({ items: await store.listScoutSearches() });
  }));
  app.get("/api/scout/searches/:id", route(async (req, res) => {
    const search = await store.getScoutSearch(req.params.id);
    if (!search) res.status(404).json({ error: "Not found." });
    else res.json(search);
  }));
  app.get("/api/scout/cases", route(async (_req, res) => {
    res.json({ cases: await store.listScoutCases(), archived: await store.listArchivedScoutCases() });
  }));
  app.post("/api/scout/cases", route(async (req, res) => {
    const scout = await import("./scout.js");
    res.json(await store.createScoutCase(scout.validateScoutCase(req.body)));
  }));
  app.put("/api/scout/cases/:id", route(async (req, res) => {
    const scout = await import("./scout.js");
    res.json(await store.updateScoutCase(req.params.id, scout.validateScoutCase({ ...req.body, id: req.params.id })));
  }));
  app.delete("/api/scout/cases/:id", route(async (req, res) => {
    await store.deleteScoutCase(req.params.id);
    res.json({ deleted: true });
  }));
  app.get("/api/scout/evals/runs", route(async (_req, res) => {
    res.json({ runs: await store.listScoutEvalRuns() });
  }));
  app.get("/api/scout/evals/runs/:id", route(async (req, res) => {
    const run = await store.getScoutEvalRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    if (!run.summary && Array.isArray(run.results)) {
      const scout = await import("./scout.js");
      run.summary = { ...scout.summarizeScout(run.results, run.providers), name: run.name, model: run.model, judgeModel: run.judgeModel, partial: true };
    }
    res.json(run);
  }));
  app.delete("/api/scout/evals/runs", route(async (_req, res) => {
    await store.clearScoutEvalRuns();
    res.json({ deleted: true });
  }));
  app.patch("/api/scout/evals/runs/:id", route(async (req, res) => {
    if (typeof req.body?.name !== "string") {
      res.status(400).json({ error: "Send the new name as text. An empty name removes it." });
      return;
    }
    res.json(await store.renameScoutEvalRun(req.params.id, req.body.name));
  }));
  app.post("/api/scout/evals/run", route(async (req, res) => {
    const [scout, evals] = await Promise.all([import("./scout.js"), import("./evals.js")]);
    const reqId = `scout-evals-${++requestCounter}`;
    const body = req.body ?? {};
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const cases = await store.listScoutCases();
    const unknown = ids.filter((id) => !cases.some((caseDef) => caseDef.id === id));
    if (!ids.length || unknown.length) {
      res.status(400).json({ error: ids.length ? `Unknown query id(s): ${unknown.join(", ")}` : "Select at least one query." });
      return;
    }
    const providers = scout.readProviders(body.providers).filter(scout.providerConfigured);
    if (!providers.length) {
      res.status(503).json({ error: "None of the selected search providers has an API key on the server." });
      return;
    }
    const model = scout.checkModel(body.model ?? scout.DEFAULT_ANSWER_MODEL);
    const judgeModel = scout.checkModel(body.judgeModel ?? scout.DEFAULT_JUDGE_MODEL);
    const judge = body.judge !== false && evals.judgeConfigured();
    const settings = Object.fromEntries(providers.map((provider) => [provider, scout.normalizeSettings(provider, body.settings?.[provider])]));
    const concurrency = Math.min(4, Math.max(1, Number(body.concurrency) || 3));
    const name = store.cleanRunName(body.name);
    const selected = cases.filter((caseDef) => ids.includes(caseDef.id));

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    const log = createLogger(reqId, (entry) => {
      if (entry.level !== "debug") writeSse(res, "log", entry);
    });
    const abort = new AbortController();
    let finished = false;
    res.on("close", () => {
      if (!finished) {
        log("warn", "Browser closed the connection; aborting remaining Scout queries");
        abort.abort();
      }
    });

    const config = { name, ids, providers, model, judge, judgeModel: judge ? judgeModel : null, settings, concurrency };
    log("info", "Scout eval run started", config);
    let runId = null;
    try {
      runId = await store.createScoutEvalRun({ name, providers, model, judgeModel: config.judgeModel, settings, summary: null });
    } catch (saveError) {
      log("warn", "Could not open a Scout eval run in MongoDB", errorDetails(saveError));
    }
    writeSse(res, "start", { ...config, runId });
    const completed = [];
    let persist = Promise.resolve();
    function remember(result) {
      completed.push(result);
      if (!runId) return;
      const summary = {
        ...scout.summarizeScout(completed.slice(), providers),
        name, model, judgeModel: config.judgeModel, settings,
        partial: completed.length < selected.length,
      };
      persist = persist.then(() => store.appendScoutEvalResult(runId, result, summary)).catch((saveError) => {
        log("warn", `Could not save query ${result.id}`, errorDetails(saveError));
      });
    }
    try {
      const results = await evals.pool(selected, concurrency, async (caseDef) => {
        if (abort.signal.aborted) return null;
        writeSse(res, "case-start", { id: caseDef.id });
        let result;
        try {
          result = await withApiContext({ surface: "scout-eval", runId, caseId: caseDef.id }, () => scout.runScoutCase(caseDef, { providers, settings, model, judge, judgeModel, signal: abort.signal }));
        } catch (error) {
          if (abort.signal.aborted) return null;
          throw error;
        }
        for (const run of Object.values(result.runs)) {
          if (run.error) {
            log("error", `Query ${caseDef.id}: ${run.provider} failed`, { message: run.error });
            run.error = uiMessage(run.error);
          }
        }
        if (result.judgeError && judge) log("warn", `Query ${caseDef.id}: grader problem`, { message: result.judgeError });
        log("info", `Query ${caseDef.id} finished`, Object.fromEntries(providers.map((provider) => [provider, {
          quality: result.grades[provider]?.quality ?? null,
          totalMs: result.runs[provider]?.totalMs ?? null,
        }])));
        remember(result);
        await persist;
        writeSse(res, "case-result", result);
        return result;
      });
      await persist;
      const finishedResults = results.filter(Boolean);
      const summary = scout.summarizeScout(finishedResults, providers);
      const partial = finishedResults.length < selected.length;
      const done = { ...summary, name, model, judgeModel: config.judgeModel, settings, partial };
      log("info", "Scout eval run finished", { name, queries: finishedResults.length, partial, quality: Object.fromEntries(providers.map((provider) => [provider, summary.byProvider[provider].quality])) });
      if (runId) {
        try {
          await store.finishScoutEvalRun(runId, done);
        } catch (saveError) {
          log("warn", "Could not finish the Scout eval run in MongoDB", errorDetails(saveError));
        }
      }
      writeSse(res, "done", { ...done, runId });
    } catch (error) {
      log("error", "Scout eval run failed", errorDetails(error));
      try {
        await persist;
        if (runId && completed.length) {
          const summary = scout.summarizeScout(completed.slice(), providers);
          await store.finishScoutEvalRun(runId, { ...summary, name, model, judgeModel: config.judgeModel, settings, partial: true });
        }
      } catch (saveError) {
        log("warn", "Could not save the partial Scout eval run", errorDetails(saveError));
      }
      writeSse(res, "error", { error: uiMessage(error instanceof Error ? error.message : String(error)) });
    } finally {
      await flushApiLogs();
      finished = true;
      res.end();
    }
  }));

  app.get("/favicon.svg", (_req, res) => {
    res.type("image/svg+xml").send(FAVICON_SVG);
  });
  app.get("/", (_req, res) => {
    res.type("html").send(page());
  });

  app.post("/api/runs", async (req, res) => {
    const reqId = `req-${++requestCounter}`;
    let streaming = false;
    const earlyLogs = [];
    const log = createLogger(reqId, (entry) => {
      if (streaming) writeSse(res, "log", entry);
      else earlyLogs.push(entry);
    });
    log("info", "POST /api/runs received", { body: req.body });

    let fields;
    try {
      fields = readFields(req.body ?? {});
      log("info", "Validated input", fields);
      new Exa();
      log("info", "Exa client created (EXA_API_KEY is set)");
    } catch (error) {
      log("error", "Request rejected before streaming", errorDetails(error));
      printError(error);
      const status = error?.statusCode === 400 ? 400 : 500;
      const message = error instanceof Error ? error.message : String(error);
      res.status(status).json({ error: uiMessage(message), debug: message, logs: earlyLogs, requestId: reqId });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    streaming = true;
    for (const entry of earlyLogs.splice(0)) writeSse(res, "log", entry);
    log("info", "SSE stream opened to browser", { requestId: reqId });
    writeSse(res, "status", { message: "Searching public signals…" });

    const abort = new AbortController();
    const timeoutMs = timeoutFor(fields.effort);
    const batchId = typeof req.body?.batchId === "string" && /^[a-f0-9]{24}$/.test(req.body.batchId) ? req.body.batchId : null;
    const batchRef = { batchId, rowIndex: batchId && Number.isInteger(req.body?.rowIndex) ? req.body.rowIndex : null };
    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log("warn", `${timeoutMs}ms timeout reached, aborting Exa run`);
      abort.abort();
    }, timeoutMs);
    res.on("close", () => {
      if (!finished) {
        console.error(`[${new Date().toISOString()}] [${reqId}] [warn] Browser closed the connection before the run finished; aborting`);
        abort.abort();
      }
    });

    const traces = new Map();
    try {
      const { run, fields: resolved } = await research(fields, {
        signal: abort.signal,
        log,
        onTrace: (raw) => {
          const trace = { ...raw, tool: uiMessage(raw.tool ?? ""), text: uiMessage(raw.text ?? "") };
          traces.set(trace.callId, { seenAt: new Date().toTimeString().slice(0, 8), ...traces.get(trace.callId), ...trace });
          writeSse(res, "trace", trace);
        },
        onStatus: (message) => {
          log("info", `Status: ${message}`);
          writeSse(res, "status", { message });
        },
      });
      printSuccess(run);
      const payload = payloadFrom(run, resolved);
      const searchId = await saveSearchQuietly({ input: inputOf(fields), result: payload, traces: [...traces.values()], status: "done", ...batchRef }, log);
      log("info", "Sending result to browser");
      writeSse(res, "result", { ...payload, searchId });
    } catch (error) {
      if (abort.signal.aborted && !timedOut) return;
      const message = timedOut
        ? `Polling timeout: the agent run did not complete within ${timeoutMs}ms`
        : (error instanceof Error ? error.message : String(error));
      printError(timedOut ? new Error(message) : error);
      if (batchRef.batchId) await saveSearchQuietly({ input: inputOf(fields), status: "error", error: uiMessage(message), ...batchRef }, log);
      log("error", "Sending error to browser", { message });
      writeSse(res, "error", { error: uiMessage(message) });
    } finally {
      finished = true;
      clearTimeout(timer);
      log("info", "Closing SSE stream");
      streaming = false;
      res.end();
    }
  });

  return app;
}

async function startServer() {
  const server = createApp().listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}`);
    console.error(`[${new Date().toISOString()}] [server] EXA_API_KEY ${process.env.EXA_API_KEY ? "is set" : "is NOT set"}`);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
}

async function runCli(argv) {
  const companyArg = clean(argv[0]);
  const exclusion = clean(argv[1] ?? "");
  const domainLike = companyArg.includes(".") && !/\s/.test(companyArg);
  try {
    const { run } = await research({
      accountName: companyArg,
      domain: domainLike ? companyArg : "",
      persona: "",
      personName: "",
      exclusion,
    });
    printSuccess(run);
  } catch (error) {
    printError(error);
    process.exit(1);
  }
}

export { research, structuredFrom, groundingFrom, signalWindow, outputSchema, EFFORTS, effortOption, timeoutFor };
export const maxDuration = 300;
export default createApp();

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length > 0) {
    await runCli(cliArgs);
  } else {
    await startServer();
  }
}
