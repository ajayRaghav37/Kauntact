import express from "express";
import Exa from "exa-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";

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

const EFFORTS = ["minimal", "low", "medium", "high"];
// Exa's published fixed per-run prices (USD). Email contact enrichment is billed on top when Exa uses it.
const EFFORT_PRICES = { minimal: 0.012, low: 0.025, medium: 0.1, high: 0.5 };
const EMAIL_ENRICHMENT_PRICE = 0.02;

function buildSystemPrompt({ start, end }, { findEmail = false } = {}) {
  let prompt = `Today is ${end}. A signal is usable only when the page states a calendar date between ${start} and ${end}, inclusive. If the page has no year, drop the signal. Allowed signals are a linkedin post, a talk, or a funding announcement. Never use a layoff. Never invent a name, date, or URL. Write opener only when person_name, signal_date, and source_url are all present. Otherwise set opener to null and verdict to cannot_verify. opener is under 25 words, said the way a sales rep would say it. Write subject only when opener is written: an email subject line under 8 words that references the signal, otherwise null. When a second CLI arg is present, do not use a signal about that event.`;
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
  let query = `Find the VP of Engineering or the CRO at ${company} and one recent public signal about that person, such as a linkedin post, a talk, or a funding announcement.`;
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

async function research(input, { onTrace, onStatus, signal, log = createLogger("cli"), quiet = false } = {}) {
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
  const timeoutSignal = signal ?? AbortSignal.timeout(180000);
  log("info", "Creating Exa agent run (stream: true)", {
    effort: fields.effort,
    findEmail: fields.findEmail,
    input: agentInput,
    timeoutMs: 180000,
  });

  const traces = new Map();
  const printed = new Map();
  const eventCounts = {};
  let run = null;
  try {
    const events = await exa.agent.runs.create(
      {
        query,
        systemPrompt: buildSystemPrompt(window, fields),
        effort: fields.effort,
        outputSchema: schemaFor(fields),
        input: agentInput,
        stream: true,
      },
      { signal: timeoutSignal }
    );
    log("info", "Exa event stream opened");

    for await (const event of events) {
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
    if (!signal && (error?.name === "AbortError" || error?.name === "TimeoutError")) {
      throw new Error("Polling timeout: the agent run did not complete within 180000ms");
    }
    throw error;
  }

  if (!run) {
    log("error", "Stream ended without agent_run.completed", { eventCounts });
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
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (typeof res.flush === "function") res.flush();
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
  <rect width="64" height="64" rx="14" fill="#0f6e56"/>
  <path d="M13 19a7 7 0 0 1 7-7h24a7 7 0 0 1 7 7v17a7 7 0 0 1-7 7H31l-10 8.5V43h-1a7 7 0 0 1-7-7z" fill="#fffcf7"/>
  <circle cx="32" cy="23" r="5.5" fill="#0f6e56"/>
  <path d="M21.5 38.5c1.6-5.6 5.6-8.5 10.5-8.5s8.9 2.9 10.5 8.5z" fill="#0f6e56"/>
  <circle cx="50" cy="14" r="6.5" fill="#e9774a" stroke="#0f6e56" stroke-width="3"/>
</svg>`;

function page() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kauntact</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    :root {
      color-scheme: light;
      --ink: #1c1915;
      --muted: #5e584f;
      --line: #d9d1c4;
      --paper: #f6f3ec;
      --card: #fffcf7;
      --accent: #0f6e56;
      --accent-ink: #e7f6f1;
      --accent-soft: #e3f1ec;
      --coral: #e9774a;
      --warn: #8a3b12;
      --warn-bg: #fde8dc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--paper);
      color: var(--ink);
      font: 16px/1.45 "Avenir Next", "Segoe UI", sans-serif;
    }
    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 64px;
    }
    header { display: flex; align-items: center; gap: 14px; }
    header img { width: 52px; height: 52px; flex: none; }
    header h1 {
      margin: 0;
      font-family: Palatino, "Iowan Old Style", "Palatino Linotype", serif;
      font-size: 38px;
      font-weight: 600;
      letter-spacing: -0.03em;
      line-height: 1.1;
    }
    header p { margin: 2px 0 0; color: var(--muted); }
    .account { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .chip { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 6px 12px; font-size: 14px; font-weight: 650; cursor: default; }
    .chip small { display: block; font-size: 11px; font-weight: 400; color: var(--muted); }
    .chip.clickable { cursor: pointer; }
    .chip.clickable:hover, .chip.clickable:focus-visible { border-color: var(--accent); outline: none; }
    .chip.editing label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 400; color: var(--muted); }
    .chip.editing input { width: 120px; border: 1px solid var(--accent); border-radius: 8px; padding: 4px 8px; font: inherit; font-size: 14px; font-weight: 650; color: var(--ink); }
    .chip.user { display: flex; align-items: center; gap: 8px; border-radius: 999px; padding: 5px 14px 5px 5px; }
    .avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font-size: 13px; }
    .estimate { color: var(--muted); font-size: 13px; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 20px;
    }
    .workspace { margin-top: 24px; display: grid; gap: 20px; }
    .workspace.idle { max-width: 680px; }
    .workspace.split { grid-template-columns: 340px minmax(0, 1fr); align-items: start; }
    .workspace.split form { position: sticky; top: 16px; }
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
    .effort-head { display: flex; justify-content: space-between; align-items: baseline; }
    .effort-value { font-size: 13px; color: var(--accent); font-weight: 650; text-transform: capitalize; }
    input[type=range] { width: 100%; accent-color: var(--accent); margin: 4px 0 0; }
    .ticks { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }
    .ticks span { display: flex; flex-direction: column; align-items: center; }
    .ticks span:first-child { align-items: flex-start; }
    .ticks span:last-child { align-items: flex-end; }
    .ticks b { font-weight: 600; color: var(--ink); }
    .check { flex-direction: row; align-items: flex-start; gap: 10px; cursor: pointer; }
    .check input { margin: 3px 0 0; accent-color: var(--accent); width: 16px; height: 16px; flex: none; }
    .check small { display: block; color: var(--warn); font-size: 12px; font-weight: 400; margin-top: 2px; }
    .hint { margin: 12px 0 0; color: var(--muted); font-size: 13px; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
    button, .button {
      appearance: none;
      border: 0;
      background: var(--accent);
      color: var(--accent-ink);
      border-radius: 999px;
      padding: 10px 18px;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    button:disabled { opacity: 0.6; cursor: wait; }
    .button.ghost, button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--line); }
    .button.disabled { opacity: 0.45; pointer-events: none; }
    .error {
      margin-top: 14px;
      background: var(--warn-bg);
      color: var(--warn);
      border-radius: 10px;
      padding: 10px 12px;
    }
    a { color: var(--accent); }
    h2 { margin: 0; font-size: 18px; }
    .result-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .company { color: var(--muted); font-size: 13px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em; }
    .person { margin: 4px 0 0; font-family: Palatino, "Iowan Old Style", serif; font-size: 28px; line-height: 1.15; }
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
    th { color: var(--muted); font-weight: 650; font-size: 12px; border-top: 0; }
    .conf { font-size: 12px; font-weight: 650; border-radius: 999px; padding: 1px 8px; background: #eee8dd; }
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
      background: #1c1915;
      color: #e9e4da;
      border-radius: 10px;
      font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace;
      list-style: none;
    }
    .logs li { white-space: pre-wrap; word-break: break-word; }
    .logs .empty { color: #8f877b; }
    .logs .server { color: #9fd6c6; }
    .logs .warn { color: #f2c57c; }
    .logs .error { color: #f4a38a; }
    .logs .tool { color: #f2c57c; }
    .logs a { color: #9fd6c6; display: block; padding-left: 2ch; }
    @media (max-width: 900px) {
      .workspace.split, .panels { grid-template-columns: 1fr; }
      .workspace.split form { position: static; }
    }
    @media (max-width: 600px) {
      header { flex-wrap: wrap; }
      .account { margin-left: 0; width: 100%; justify-content: flex-start; }
      .grid { grid-template-columns: 1fr; }
      header h1 { font-size: 30px; }
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
const EFFORT_PRICES = ${JSON.stringify(EFFORT_PRICES)};
const EMAIL_ENRICHMENT_PRICE = ${JSON.stringify(EMAIL_ENRICHMENT_PRICE)};

function money(value, digits) {
  return "$" + Number(value).toFixed(digits === undefined ? 2 : digits);
}

function balanceMoney(value) {
  const cents = value * 100;
  return money(value, Math.abs(cents - Math.round(cents)) < 1e-6 ? 2 : 3);
}

function Account(props) {
  const account = props.account;
  const spent = props.spent;
  const sessionTotal = spent.reduce(function (sum, run) { return sum + run.cost; }, 0);
  const estimate = props.estimate;
  const [editing, setEditing] = useState(false);
  const live = Boolean(account && account.balance && account.balance.available);
  let balanceText;
  let balanceTitle;
  if (live) {
    const since = Date.parse(account.balance.generatedAt);
    const unbilled = spent.filter(function (run) { return run.at > since; })
      .reduce(function (sum, run) { return sum + run.cost; }, 0);
    balanceText = (unbilled ? "≈ " : "") + money(account.balance.creditsUsd - unbilled) + " left";
    balanceTitle = "Exa credit balance" + (unbilled ? ", minus " + money(unbilled, 4) + " of searches Exa has not reported yet (its balance can lag up to 5 minutes)" : "");
  } else if (estimate.userSet) {
    balanceText = "≈ " + balanceMoney(estimate.amount) + " left";
    balanceTitle = "Running estimate: the balance you entered minus the actual cost of each search since. This is not an actual real-time balance. Click to correct it.";
  } else {
    balanceText = balanceMoney(estimate.amount) + " left";
    balanceTitle = "This is a made-up number. Click to enter your balance from dashboard.exa.ai/billing, and Kauntact will subtract each search's cost from it.";
  }

  function commit(event) {
    if (!editing) return;
    const amount = Number(event.target.value);
    if (event.target.value.trim() !== "" && Number.isFinite(amount) && amount >= 0) {
      props.onEstimate({ amount: amount, userSet: true });
    }
    setEditing(false);
  }

  const balanceChip = editing
    ? e("div", { className: "chip editing" },
        e("label", null, "Your Exa balance ($)",
          e("input", {
            type: "number",
            min: 0,
            step: 0.01,
            autoFocus: true,
            defaultValue: estimate.amount.toFixed(2),
            onBlur: commit,
            onKeyDown: function (event) {
              if (event.key === "Enter") commit(event);
              if (event.key === "Escape") setEditing(false);
            }
          })
        )
      )
    : e("div", {
        className: "chip" + (live ? "" : " clickable"),
        title: balanceTitle,
        role: live ? undefined : "button",
        tabIndex: live ? undefined : 0,
        onClick: live ? undefined : function () { setEditing(true); },
        onKeyDown: live ? undefined : function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setEditing(true); } }
      }, balanceText,
        e("small", null, "Spent this session " + money(sessionTotal, 3))
      );

  return e("div", { className: "account" },
    balanceChip,
    e("div", { className: "chip user", title: account && account.username ? "Signed in as " + account.username : "No sign-in (local)" },
      e("span", { className: "avatar" }, ((account && account.username) || "?").slice(0, 1).toUpperCase()),
      (account && account.username) || "Local"
    )
  );
}

function CostEstimate(props) {
  const base = EFFORT_PRICES[props.effort];
  return e("span", { className: "estimate" },
    "Estimated cost ≈ " + money(base, 3) + " (" + props.effort + " effort)",
    props.findEmail ? " + up to " + money(EMAIL_ENRICHMENT_PRICE) + " if Exa bills email enrichment" : ""
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
        e("div", { className: "company" }, show(result.company)),
        e("h2", { className: "person" }, result.person_name || "No verified contact"),
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
  return e(LogPanel, {
    title: "Search traces",
    version: props.traces.reduce(function (n, t) { return n + 1 + (t.urls || []).length; }, 0),
    empty: props.loading ? "Waiting for the agent's first search…" : "Search traces appear here while the agent works."
  }, props.traces.map(function (trace) {
    return e("li", { key: trace.callId },
      (trace.seenAt || "") + " ",
      trace.tool ? e("span", { className: "tool" }, trace.tool + " ") : null,
      trace.text || "Searching…",
      (trace.urls || []).map(function (url) {
        return e("a", { key: url, href: url, target: "_blank", rel: "noreferrer" }, "↳ " + url);
      })
    );
  }));
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

function Effort(props) {
  const index = Math.max(0, EFFORTS.indexOf(props.value));
  return e("div", { className: "field wide" },
    e("div", { className: "effort-head" },
      e("label", { className: "label", htmlFor: "effort" }, "Effort"),
      e("span", { className: "effort-value" }, props.value)
    ),
    e("input", {
      id: "effort",
      type: "range",
      min: 0,
      max: EFFORTS.length - 1,
      step: 1,
      value: index,
      onChange: function (event) { props.onChange(EFFORTS[Number(event.target.value)]); }
    }),
    e("div", { className: "ticks" }, EFFORTS.map(function (name) {
      return e("span", { key: name }, name, e("b", null, money(EFFORT_PRICES[name], 3)));
    })),
    e("p", { className: "hint", style: { marginTop: 4 } }, "Higher effort searches deeper but takes longer. Exa charges a fixed price per search for each effort.")
  );
}

function App() {
  const [logs, setLogs] = useState([]);

  function log(level, message, details) {
    const entry = { time: new Date().toISOString(), source: "ui", level: level, message: message, details: details };
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    console[method]("[ui] " + message, details === undefined ? "" : details);
    setLogs(function (current) { return current.concat([entry]); });
  }

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
  const [spent, setSpent] = useState([]);
  const [estimate, setEstimate] = useState(function () {
    try {
      const saved = JSON.parse(localStorage.getItem("kauntact.balance"));
      if (saved && typeof saved.amount === "number") return saved;
    } catch (storageError) {}
    return { amount: 10, userSet: false };
  });
  useEffect(function () {
    localStorage.setItem("kauntact.balance", JSON.stringify(estimate));
  }, [estimate]);

  function updateEstimate(next) {
    setEstimate(next);
    log("info", "Balance estimate set", next);
  }

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
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const type = response.headers.get("Content-Type") || "";
      log("info", "Response headers received", { status: response.status, contentType: type, afterMs: Date.now() - started });
      if (type.indexOf("text/event-stream") === -1) {
        const body = await response.json();
        if (!response.ok) {
          log("error", "Server returned an error", body);
          setError(body.error || "The run failed.");
          return;
        }
        log("info", "Received JSON result", body);
        setResult(body);
      } else {
        log("info", "Reading event stream");
        await readSse(response, function (message) {
          eventCount += 1;
          if (message.event === "log") {
            addServerLog(message.data);
            return;
          }
          log("debug", "Stream event: " + message.event, message.data);
          if (message.event === "status") {
            setStatus(message.data.message || "Searching public signals…");
          } else if (message.event === "trace") {
            setTraces(function (current) {
              const next = current.slice();
              const index = next.findIndex(function (item) { return item.callId === message.data.callId; });
              if (index === -1) next.push(Object.assign({ seenAt: new Date().toTimeString().slice(0, 8) }, message.data));
              else next[index] = Object.assign({}, next[index], message.data);
              return next;
            });
          } else if (message.event === "result") {
            setResult(message.data);
            const cost = message.data.costDollars && message.data.costDollars.total;
            if (typeof cost === "number") {
              setSpent(function (current) { return current.concat([{ cost: cost, at: Date.now() }]); });
              setEstimate(function (current) {
                return { amount: Math.max(0, Math.round((current.amount - cost) * 1e6) / 1e6), userSet: current.userSet };
              });
            }
          } else if (message.event === "error") {
            setError(message.data.error || "The run failed.");
          } else {
            log("warn", "Unknown stream event: " + message.event);
          }
        });
        log("info", "Event stream closed", { events: eventCount, afterMs: Date.now() - started });
      }
    } catch (requestError) {
      log("error", "Request failed", { name: requestError.name, message: requestError.message });
      setError(requestError.message || "The run failed.");
    } finally {
      setLoading(false);
      loadAccount("after search");
    }
  }

  return e("div", null,
    e("header", null,
      e("img", { src: "/favicon.svg", alt: "" }),
      e("div", null,
        e("h1", null, "Kauntact"),
        e("p", null, "Who to reach, and why now. Find a VP of Engineering or CRO with one recent public signal.")
      ),
      e(Account, { account: account, spent: spent, estimate: estimate, onEstimate: updateEstimate })
    ),
    e("div", { className: "workspace " + (started ? "split" : "idle") },
      e("form", { className: "card", onSubmit: onSubmit },
        e("div", { className: "grid" },
          e(Field, { id: "accountName", label: "Account name", value: accountName, onChange: setAccountName, placeholder: "Acme" }),
          e(Field, { id: "domain", label: "Domain name", value: domain, onChange: setDomain, placeholder: "acme.com" }),
          e(Field, { id: "persona", label: "Persona", value: persona, onChange: setPersona, placeholder: "Optional" }),
          e(Field, { id: "personName", label: "Person name", value: personName, onChange: setPersonName, placeholder: "Optional" }),
          e(Field, { id: "exclusion", label: "Exclusion rules", value: exclusion, onChange: setExclusion, placeholder: "Optional event to leave out", wide: true, multiline: true }),
          e(Effort, { value: effort, onChange: setEffort }),
          e("label", { className: "field wide check" },
            e("input", { type: "checkbox", checked: findEmail, onChange: function (event) { setFindEmail(event.target.checked); } }),
            e("span", null, "Get the recipient's email address",
              e("small", null, "Costs a little extra: up to " + money(EMAIL_ENRICHMENT_PRICE) + " more if Exa uses its email enrichment to find the address."))
          )
        ),
        e("p", { className: "hint" }, "Provide an account name or a domain name. Everything else is optional."),
        e("div", { className: "actions" },
          e("button", { type: "submit", disabled: loading }, loading ? "Searching…" : "Find signal"),
          e(CostEstimate, { effort: effort, findEmail: findEmail })
        ),
        error ? e("div", { className: "error", role: "alert" }, error) : null
      ),
      started
        ? (result ? e(Result, { result: result }) : loading ? e(Pending, { status: status }) : null)
        : null
    ),
    e("div", { className: "panels" },
      e(Traces, { traces: traces, loading: loading }),
      e(DebugLog, { logs: logs, onClear: function () { setLogs([]); } })
    )
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

function createApp() {
  const app = express();
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      console.error(`[${new Date().toISOString()}] [http] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });
  app.use(requirePassword);
  app.use(express.json({ limit: "100kb" }));

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
      res.status(status).json({ error: error instanceof Error ? error.message : String(error), requestId: reqId });
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
    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log("warn", "180000ms timeout reached, aborting Exa run");
      abort.abort();
    }, 180000);
    res.on("close", () => {
      if (!finished) {
        console.error(`[${new Date().toISOString()}] [${reqId}] [warn] Browser closed the connection before the run finished; aborting`);
        abort.abort();
      }
    });

    try {
      const { run, fields: resolved } = await research(fields, {
        signal: abort.signal,
        log,
        onTrace: (trace) => writeSse(res, "trace", trace),
        onStatus: (message) => {
          log("info", `Status: ${message}`);
          writeSse(res, "status", { message });
        },
      });
      printSuccess(run);
      log("info", "Sending result to browser");
      writeSse(res, "result", payloadFrom(run, resolved));
    } catch (error) {
      if (abort.signal.aborted && !timedOut) return;
      const message = timedOut
        ? "Polling timeout: the agent run did not complete within 180000ms"
        : (error instanceof Error ? error.message : String(error));
      printError(timedOut ? new Error(message) : error);
      log("error", "Sending error to browser", { message });
      writeSse(res, "error", { error: message });
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
  server.requestTimeout = 200000;
  server.headersTimeout = 210000;
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

export { research, structuredFrom, groundingFrom, signalWindow, outputSchema };
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
