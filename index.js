import express from "express";
import Exa from "exa-js";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
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

function buildSystemPrompt({ start, end }) {
  return `Today is ${end}. A signal is usable only when the page states a calendar date between ${start} and ${end}, inclusive. If the page has no year, drop the signal. Allowed signals are a linkedin post, a talk, or a funding announcement. Never use a layoff. Never invent a name, date, or URL. Write opener only when person_name, signal_date, and source_url are all present. Otherwise set opener to null and verdict to cannot_verify. opener is under 25 words, said the way a sales rep would say it. When a second CLI arg is present, do not use a signal about that event.`;
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

function buildQuery({ company, accountName, domain, persona, personName, exclusion }) {
  let query = `Find the VP of Engineering or the CRO at ${company} and one recent public signal about that person, such as a linkedin post, a talk, or a funding announcement.`;
  if (accountName && domain) query += ` Domain: ${domain}.`;
  if (persona) query += ` Persona: ${persona}.`;
  if (personName) query += ` Person name: ${personName}.`;
  if (exclusion) query += ` Second CLI arg: ${exclusion}.`;
  return query;
}

function readFields(input) {
  const accountName = clean(input.accountName);
  const domain = clean(input.domain);
  const persona = clean(input.persona);
  const personName = clean(input.personName);
  const exclusion = clean(input.exclusion);
  const company = companyFrom(accountName, domain);
  return { accountName, domain, persona, personName, exclusion, company };
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
    effort: "low",
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
        systemPrompt: buildSystemPrompt(window),
        effort: "low",
        outputSchema,
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
    verdict: result.verdict ?? null,
    costDollars: { total: run?.costDollars?.total ?? null },
    grounding: groundingFrom(run),
  };
}

function page() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Account signal</title>
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
      width: min(920px, calc(100% - 32px));
      margin: 0 auto;
      padding: 40px 0 64px;
    }
    header h1 {
      margin: 0 0 8px;
      font-family: Palatino, "Iowan Old Style", "Palatino Linotype", serif;
      font-size: 40px;
      font-weight: 600;
      letter-spacing: -0.03em;
    }
    header p { margin: 0; color: var(--muted); max-width: 62ch; }
    form, .result {
      margin-top: 24px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px 16px;
    }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field.wide { grid-column: 1 / -1; }
    label span { font-size: 13px; font-weight: 650; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      border-radius: 10px;
      padding: 10px 12px;
      font: inherit;
    }
    textarea { min-height: 84px; resize: vertical; }
    .hint { margin: 12px 0 0; color: var(--muted); font-size: 14px; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
    button {
      appearance: none;
      border: 0;
      background: var(--accent);
      color: var(--accent-ink);
      border-radius: 999px;
      padding: 10px 16px;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }
    button:disabled { opacity: 0.6; cursor: wait; }
    .error {
      margin-top: 14px;
      background: var(--warn-bg);
      color: var(--warn);
      border-radius: 10px;
      padding: 10px 12px;
    }
    .status { color: var(--muted); font-size: 14px; }
    dl { display: grid; grid-template-columns: 140px 1fr; gap: 8px 12px; margin: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; }
    a { color: var(--accent); }
    .grounding { margin: 16px 0 0; padding: 0; list-style: none; }
    .grounding li, .traces li { padding: 10px 0; border-top: 1px solid var(--line); }
    .traces { list-style: none; margin: 0; padding: 0; }
    .traces li:first-child { border-top: 0; padding-top: 0; }
    .traces a { display: block; margin-top: 4px; word-break: break-all; }
    .meta { color: var(--muted); font-size: 14px; }
    h2 { margin: 0 0 12px; font-size: 20px; }
    .logs-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .logs-head h2 { margin: 0; }
    .logs-head button { background: transparent; color: var(--accent); border: 1px solid var(--line); padding: 6px 12px; font-size: 14px; }
    .logs {
      margin: 12px 0 0;
      padding: 12px;
      max-height: 320px;
      overflow: auto;
      background: #1c1915;
      color: #e9e4da;
      border-radius: 10px;
      font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace;
      list-style: none;
    }
    .logs li { white-space: pre-wrap; word-break: break-word; }
    .logs .server { color: #9fd6c6; }
    .logs .warn { color: #f2c57c; }
    .logs .error { color: #f4a38a; background: transparent; margin: 0; padding: 0; }
    @media (max-width: 700px) {
      .grid { grid-template-columns: 1fr; }
      dl { grid-template-columns: 1fr; }
      header h1 { font-size: 32px; }
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
const { useState } = React;

function show(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function Field(props) {
  return e("label", { className: "field" + (props.wide ? " wide" : "") },
    e("span", null, props.label),
    e(props.multiline ? "textarea" : "input", {
      id: props.id,
      name: props.id,
      value: props.value,
      placeholder: props.placeholder || "",
      onChange: function (event) { props.onChange(event.target.value); }
    })
  );
}

function Result(props) {
  const result = props.result;
  const grounding = result.grounding || [];
  return e("section", { className: "result" },
    e("h2", null, "Result"),
    e("dl", null,
      e("dt", null, "OPENER"),
      e("dd", null, show(result.opener)),
      e("dt", null, "PERSON"),
      e("dd", null, show(result.person_name)),
      e("dt", null, "Title"),
      e("dd", null, show(result.person_title)),
      e("dt", null, "DATE"),
      e("dd", null, show(result.signal_date)),
      e("dt", null, "URL"),
      e("dd", null, result.source_url
        ? e("a", { href: result.source_url, target: "_blank", rel: "noreferrer" }, result.source_url)
        : "—"),
      e("dt", null, "VERDICT"),
      e("dd", null, show(result.verdict)),
      e("dt", null, "Signal"),
      e("dd", null, show(result.signal)),
      e("dt", null, "costDollars.total"),
      e("dd", null, show(result.costDollars && result.costDollars.total))
    ),
    grounding.length
      ? e("ul", { className: "grounding" }, grounding.map(function (entry, index) {
          return e("li", { key: index },
            "field: " + show(entry.field) + " confidence: " + show(entry.confidence) + " urls: " + ((entry.urls || []).join(" ") || "—")
          );
        }))
      : null
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

function Traces(props) {
  if (!props.loading && !props.traces.length && !props.status) return null;
  return e("section", { className: "result", "aria-live": "polite", "aria-busy": props.loading ? "true" : "false" },
    e("h2", null, props.loading ? "Searching" : "Search traces"),
    props.loading ? e("p", { className: "status" }, props.status || "Searching public signals…") : null,
    props.traces.length
      ? e("ol", { className: "traces" }, props.traces.map(function (trace) {
          return e("li", { key: trace.callId },
            e("div", null, trace.text || "Searching…"),
            trace.tool ? e("div", { className: "meta" }, trace.tool) : null,
            (trace.urls || []).map(function (url) {
              return e("a", { key: url, href: url, target: "_blank", rel: "noreferrer" }, url);
            })
          );
        }))
      : null
  );
}

function formatLog(entry) {
  const time = (entry.time || "").slice(11, 23);
  const scope = entry.scope ? " [" + entry.scope + "]" : "";
  const details = entry.details === undefined ? "" : " " + JSON.stringify(entry.details);
  return time + " " + entry.source + scope + " " + entry.level.toUpperCase() + " " + entry.message + details;
}

function DebugLog(props) {
  return e("section", { className: "result" },
    e("div", { className: "logs-head" },
      e("h2", null, "Debug log"),
      e("button", { type: "button", onClick: props.onClear }, "Clear")
    ),
    props.logs.length
      ? e("ol", { className: "logs" }, props.logs.map(function (entry, index) {
          return e("li", { key: index, className: entry.source + " " + entry.level }, formatLog(entry));
        }))
      : e("p", { className: "status" }, "No log entries yet. Submit the form to start.")
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
      exclusion: exclusion
    };
    log("info", "Find signal clicked", payload);
    if (!accountName.trim() && !domain.trim()) {
      log("warn", "Validation failed: account name and domain are both empty");
      setError("At least one of account name or domain must be provided.");
      return;
    }
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
              if (index === -1) next.push(message.data);
              else next[index] = message.data;
              return next;
            });
          } else if (message.event === "result") {
            setResult(message.data);
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
    }
  }

  return e("div", null,
    e("header", null,
      e("h1", null, "Account signal"),
      e("p", null, "Find a VP of Engineering or CRO and one recent public signal: a LinkedIn post, a talk, or a funding announcement.")
    ),
    e("form", { onSubmit: onSubmit },
      e("div", { className: "grid" },
        e(Field, { id: "accountName", label: "Account name", value: accountName, onChange: setAccountName, placeholder: "Acme" }),
        e(Field, { id: "domain", label: "Domain name", value: domain, onChange: setDomain, placeholder: "acme.com" }),
        e(Field, { id: "persona", label: "Persona", value: persona, onChange: setPersona, placeholder: "Optional" }),
        e(Field, { id: "personName", label: "Person name", value: personName, onChange: setPersonName, placeholder: "Optional" }),
        e(Field, { id: "exclusion", label: "Exclusion rules", value: exclusion, onChange: setExclusion, placeholder: "Optional event to leave out", wide: true, multiline: true })
      ),
      e("p", { className: "hint" }, "Provide an account name or a domain name. Persona, person name, and exclusion rules are optional."),
      e("div", { className: "actions" },
        e("button", { type: "submit", disabled: loading }, loading ? "Searching…" : "Find signal")
      ),
      error ? e("div", { className: "error", role: "alert" }, error) : null
    ),
    e(Traces, { traces: traces, loading: loading, status: status }),
    result ? e(Result, { result: result }) : null,
    e(DebugLog, { logs: logs, onClear: function () { setLogs([]); } })
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(e(App));
`;
}

function vendorPath(packageName, file) {
  return path.join(path.dirname(require.resolve(packageName + "/package.json")), file);
}

async function startServer() {
  const app = express();
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      console.error(`[${new Date().toISOString()}] [http] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });
  app.use(express.json({ limit: "100kb" }));

  app.get("/vendor/react.js", (_req, res) => {
    res.sendFile(vendorPath("react", "umd/react.development.js"));
  });
  app.get("/vendor/react-dom.js", (_req, res) => {
    res.sendFile(vendorPath("react-dom", "umd/react-dom.development.js"));
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

  const server = app.listen(PORT, () => {
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

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length > 0) {
    await runCli(cliArgs);
  } else {
    await startServer();
  }
}
