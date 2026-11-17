// Write-only log of outbound Exa, Tavily, and LLM calls.
// A failed eval can be reconstructed from these records. Nothing in the app reads them
// back to answer, skip, or reuse a query. This is not a cache.
import { AsyncLocalStorage } from "node:async_hooks";
import * as store from "./store.js";

const storage = new AsyncLocalStorage();
const BODY_LIMIT = 4_000_000;
const SECRET_HEADERS = new Set([
  "authorization",
  "api-key",
  "x-api-key",
  "x-api-token",
  "x-auth-token",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

let seen = 0;
let chain = Promise.resolve();
let installed = false;

export function apiLogSeen() {
  return seen;
}

export function currentApiContext() {
  return storage.getStore() || {};
}

// Later fields win, so a grader call can set purpose without dropping the eval's run id.
export function withApiContext(extra, fn) {
  return storage.run({ ...currentApiContext(), ...extra }, fn);
}

// Existing context wins, so a direct search is tagged and an eval keeps its own tag.
export function withApiContextDefaults(extra, fn) {
  return storage.run({ ...extra, ...currentApiContext() }, fn);
}

export function flushApiLogs() {
  return chain;
}

function track(promise) {
  const tracked = Promise.resolve(promise).catch(() => {});
  chain = chain.then(() => tracked);
  return tracked;
}

function secretValues() {
  return [process.env.EXA_API_KEY, process.env.EXA_SERVICE_KEY, process.env.TAVILY_API_KEY, process.env.GROVE_API_KEY].filter((value) => value && value.length >= 8);
}

function scrub(text) {
  let out = String(text).replaceAll("\u0000", "");
  for (const secret of secretValues()) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function capText(text, keepEnd) {
  if (text.length <= BODY_LIMIT) return { text, truncated: false };
  return { text: keepEnd ? text.slice(-BODY_LIMIT) : text.slice(0, BODY_LIMIT), truncated: true };
}

export function redactHeaders(headers) {
  const source = headers instanceof Headers ? headers : new Headers(headers || {});
  const out = {};
  source.forEach((value, key) => {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? "[redacted]" : scrub(value);
  });
  return out;
}

function llmHosts() {
  const hosts = new Set();
  for (const value of [process.env.GROVE_ENDPOINT, process.env.GROVE_OPENAI_ENDPOINT]) {
    if (!value) continue;
    try {
      hosts.add(new URL(value).host);
    } catch {
      // An unusable endpoint simply is not logged as an LLM host.
    }
  }
  return hosts;
}

export function classifyUrl(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value));
  } catch {
    return null;
  }
  const host = url.host;
  if (host === "api.tavily.com" || host.endsWith(".tavily.com")) return { provider: "tavily", url };
  if (host === "api.exa.ai" || host.endsWith(".exa.ai")) return { provider: "exa", url };
  if (llmHosts().has(host)) return { provider: "llm", url };
  return null;
}

function operationFor(url, provider) {
  const path = url.pathname;
  if (provider === "tavily") return "search";
  if (provider === "llm") return "chat";
  if (path.includes("/search")) return "search";
  if (path.includes("/contents")) return "contents";
  if (path.includes("/agent")) return "agent";
  if (path.includes("/monitors")) return "monitor";
  if (path.includes("/answer")) return "answer";
  if (path.includes("/credits")) return "balance";
  const tail = path.split("/").filter(Boolean).pop();
  return tail || "request";
}

function safeUrl(url) {
  const copy = new URL(url.href);
  for (const param of ["api_key", "apikey", "key", "token", "access_token"]) {
    if (copy.searchParams.has(param)) copy.searchParams.set(param, "[redacted]");
  }
  return scrub(copy.toString());
}

function requestParts(input, init) {
  const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  let body = "";
  if (typeof init?.body === "string") body = init.body;
  else if (init?.body instanceof URLSearchParams) body = init.body.toString();
  return { method, rawUrl, headers, body };
}

function isEventStream(headers, response) {
  const accept = headers.get("accept") || "";
  const type = response.headers.get("content-type") || "";
  return accept.toLowerCase().includes("text/event-stream") || type.toLowerCase().includes("text/event-stream");
}

async function insertCall(doc) {
  try {
    if (!store.mongoConfigured()) return null;
    return await store.insertApiCall(doc);
  } catch {
    return null;
  }
}

async function updateCall(id, fields) {
  try {
    if (!id || !store.mongoConfigured()) return;
    await store.updateApiCall(id, fields);
  } catch {
    // The call itself already finished. A log write must not change its result.
  }
}

export function createLoggedFetch(original, hooks = {}) {
  const insert = hooks.insert || insertCall;
  const update = hooks.update || updateCall;
  const follow = hooks.track || track;
  return async function loggedFetch(input, init) {
    seen += 1;
    const parts = requestParts(input, init);
    const classified = classifyUrl(parts.rawUrl);
    if (!classified) return original(input, init);

    const context = currentApiContext();
    const operation = operationFor(classified.url, classified.provider);
    const requestBody = capText(scrub(parts.body), false);
    const base = {
      provider: classified.provider,
      operation,
      purpose: context.purpose || operation,
      surface: context.surface || null,
      runId: context.runId || null,
      caseId: context.caseId || null,
      method: parts.method,
      url: safeUrl(classified.url),
      requestHeaders: redactHeaders(parts.headers),
      requestBody: requestBody.text,
      truncated: requestBody.truncated,
    };
    const started = Date.now();
    let response;
    try {
      response = await original(input, init);
    } catch (error) {
      await insert({ ...base, status: null, responseHeaders: {}, responseBody: "", error: scrub(error instanceof Error ? error.message : String(error)), durationMs: Date.now() - started, pending: false });
      throw error;
    }

    const responseHeaders = redactHeaders(response.headers);
    if (isEventStream(parts.headers, response)) {
      let copy;
      try {
        copy = response.clone();
      } catch {
        await insert({ ...base, status: response.status, responseHeaders, responseBody: "", truncated: base.truncated, error: "The response body could not be copied into the log.", durationMs: Date.now() - started, pending: false });
        return response;
      }
      const bodyPromise = copy.text().catch(() => "");
      const id = await insert({
        ...base,
        status: response.status,
        responseHeaders,
        responseBody: "",
        error: null,
        durationMs: null,
        pending: true,
      });
      follow(bodyPromise.then(async (text) => {
        const capped = capText(scrub(text), true);
        await update(id, {
          responseBody: capped.text,
          truncated: base.truncated || capped.truncated,
          durationMs: Date.now() - started,
          pending: false,
        });
      }));
      return response;
    }

    let text = "";
    try {
      text = await response.clone().text();
    } catch {
      text = "";
    }
    const capped = capText(scrub(text), false);
    await insert({
      ...base,
      status: response.status,
      responseHeaders,
      responseBody: capped.text,
      truncated: base.truncated || capped.truncated,
      error: null,
      durationMs: Date.now() - started,
      pending: false,
    });
    return response;
  };
}

export function installApiLogger() {
  if (installed || typeof globalThis.fetch !== "function") return;
  installed = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createLoggedFetch(original);
}

installApiLogger();
