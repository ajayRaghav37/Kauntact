// Browser code for the Delulu Scout and Scout Evals tabs, inlined into the page after the main client code.
// It is a template literal: no backticks or dollar-brace sequences, and backslashes are doubled.
export function scoutClientJs() {
  return `
const PROVIDER_NAMES = { exa: "Exa", tavily: "Tavily" };
const PROVIDER_CHOICES = [["exa", "Exa"], ["tavily", "Tavily"], ["both", "Both"]];

function scoutDefaults(config) {
  const out = {};
  Object.keys(config.settings).forEach(function (provider) {
    out[provider] = {};
    config.settings[provider].forEach(function (field) { out[provider][field.key] = field.default; });
  });
  return out;
}

function changedSettings(config, settings, providers) {
  let count = 0;
  providers.forEach(function (provider) {
    config.settings[provider].forEach(function (field) {
      if (String(settings[provider][field.key]) !== String(field.default)) count += 1;
    });
  });
  return count;
}

function providerConfigured(config, provider) {
  return config.providers.some(function (entry) { return entry.id === provider && entry.configured; });
}

function pickSettings(settings, providers) {
  const out = {};
  providers.forEach(function (provider) { out[provider] = settings[provider]; });
  return out;
}

function modelLabel(model, defaultModel) {
  return model.id + (model.id === defaultModel ? " (default)" : "") + " · $" + model.input + " / $" + model.output + " per M tokens";
}

function ScoutOptions(props) {
  const config = props.config;
  function setField(provider, field, raw) {
    const match = field.options ? field.options.find(function (option) { return String(option[0]) === raw; }) : null;
    const value = field.options ? (match ? match[0] : field.default) : Number(raw);
    const next = Object.assign({}, props.settings);
    next[provider] = Object.assign({}, next[provider]);
    next[provider][field.key] = value;
    props.onSettings(next);
  }
  return e("div", { className: "scout-options" },
    props.providers.map(function (provider) {
      return e("fieldset", { key: provider, className: "scout-fieldset", disabled: props.disabled },
        e("legend", null, PROVIDER_NAMES[provider] + " search"),
        e("div", { className: "scout-fields" }, config.settings[provider].map(function (field) {
          const id = props.idPrefix + "-" + provider + "-" + field.key;
          const value = props.settings[provider][field.key];
          return e("label", { key: field.key, className: "field", htmlFor: id },
            e("span", null, field.label),
            field.options
              ? e("select", { id: id, value: String(value), onChange: function (event) { setField(provider, field, event.target.value); } },
                  field.options.map(function (option) { return e("option", { key: String(option[0]), value: String(option[0]) }, option[1]); }))
              : e("input", { id: id, type: "number", min: field.min, max: field.max, value: value, onChange: function (event) { setField(provider, field, event.target.value); } })
          );
        }))
      );
    }),
    e("fieldset", { className: "scout-fieldset", disabled: props.disabled },
      e("legend", null, "Answer LLM"),
      e("label", { className: "field", htmlFor: props.idPrefix + "-model" },
        e("span", null, "Model that writes the answer from the search results"),
        e("select", { id: props.idPrefix + "-model", value: props.model, onChange: function (event) { props.onModel(event.target.value); } },
          config.models.map(function (model) { return e("option", { key: model.id, value: model.id }, modelLabel(model, config.defaultModel)); }))
      )
    ),
    e("button", { type: "button", className: "link", disabled: props.disabled, onClick: props.onReset }, "Reset to defaults")
  );
}

function OptionsToggle(props) {
  return e("button", { type: "button", className: "link options-toggle", "aria-expanded": props.open, onClick: props.onToggle },
    (props.open ? "Hide search options" : "Search options") + (props.changed ? " (" + props.changed + " changed)" : ""));
}

function CitedText(props) {
  const sources = props.sources || [];
  return e("div", { className: "scout-text" }, String(props.text || "").split("\\n").filter(function (line) { return line.trim(); }).map(function (line, lineIndex) {
    const parts = line.replace(/\\*\\*/g, "").split(/(\\[\\d+\\])/);
    return e("p", { key: lineIndex }, parts.map(function (part, index) {
      const match = part.match(/^\\[(\\d+)\\]$/);
      if (!match) return part;
      const source = sources[Number(match[1]) - 1];
      return source
        ? e("a", { key: index, className: "cite", href: source.url, target: "_blank", rel: "noreferrer", title: source.title }, match[1])
        : e("span", { key: index, className: "cite missing", title: "No such source" }, match[1]);
    }));
  }));
}

function LatencyChip(props) {
  if (typeof props.ms !== "number") return null;
  const ok = props.ms <= props.limit;
  return e("span", { className: "lat " + (ok ? "ok" : "slow"), title: (ok ? "Within " : "Over ") + "the " + seconds(props.limit) + " limit" },
    props.label + " " + seconds(props.ms));
}

function ScoutAnswer(props) {
  const run = props.run;
  const limits = props.limits;
  const sources = run.sources || [];
  return e("section", { className: "card scout-answer" },
    e("div", { className: "panel-head" },
      e("h2", null, PROVIDER_NAMES[run.provider] || run.provider),
      props.grade ? e("span", { className: "pill " + (props.grade.quality >= 70 ? "pass" : "fail"), title: props.grade.reason }, "Quality " + props.grade.quality) : e("span", { className: "muted small-text" }, run.model)
    ),
    e("div", { className: "scout-stats" },
      e(LatencyChip, { label: "Search", ms: run.searchMs, limit: limits.searchMs }),
      e(LatencyChip, { label: "Total", ms: run.answer ? run.totalMs : null, limit: limits.totalMs }),
      e("span", null, "Search " + money(run.searchCost || 0, 4)),
      e("span", null, "LLM " + money(run.llmCost || 0, 4)),
      e("span", null, sources.length + " source" + (sources.length === 1 ? "" : "s"))
    ),
    run.error ? e("div", { className: "error", role: "alert" }, run.error) : null,
    run.answer ? e(CitedText, { text: run.answer, sources: sources }) : null,
    props.grade ? e(GradeDetails, { grade: props.grade, mustInclude: props.mustInclude || [] }) : null,
    sources.length ? e("details", { className: "grounding" },
      e("summary", null, "Sources"),
      e("ol", { className: "scout-sources" }, sources.map(function (source, index) {
        return e("li", { key: index },
          e("a", { href: source.url, target: "_blank", rel: "noreferrer" }, source.title || source.url),
          source.publishedDate ? e("span", { className: "muted" }, " · " + String(source.publishedDate).slice(0, 10)) : null
        );
      }))
    ) : null
  );
}

function GradeDetails(props) {
  const grade = props.grade;
  return e("div", { className: "grade-details small-text" },
    e("div", null, ["completeness", "accuracy", "freshness", "citations"].map(function (key) {
      return e("span", { key: key, className: "grade-chip" }, key + " " + grade[key] + "/5");
    }), grade.falseNegative ? e("span", { className: "grade-chip bad" }, "false “no”") : null),
    grade.reason ? e("p", { className: "muted" }, grade.reason) : null,
    props.mustInclude.length ? e("p", null, "Must include: ", props.mustInclude.map(function (fact, index) {
      const hit = grade.mustInclude[index];
      return e("span", { key: index, className: hit ? "fact hit" : "fact miss" }, (hit ? "✓ " : "✗ ") + fact);
    })) : null,
    grade.missedFacts && grade.missedFacts.length ? e("p", null, e("span", { className: "muted" }, "Missed: "), grade.missedFacts.join("; ")) : null
  );
}

function ProviderSwitch(props) {
  return e("div", { className: "mode-switch", role: "tablist", "aria-label": "Search provider" },
    PROVIDER_CHOICES.map(function (option) {
      const needsTavily = option[0] !== "exa";
      const off = needsTavily && !providerConfigured(props.config, "tavily");
      return e("button", {
        key: option[0],
        type: "button",
        role: "tab",
        "aria-selected": props.value === option[0],
        className: props.value === option[0] ? "active" : "",
        disabled: props.disabled || off,
        title: off ? "Add TAVILY_API_KEY on the server to search with Tavily." : "",
        onClick: function () { props.onChange(option[0]); }
      }, option[1]);
    })
  );
}

function Scout(props) {
  const [config, setConfig] = useState(null);
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState("exa");
  const [showOptions, setShowOptions] = useState(false);
  const [settings, setSettings] = useState(null);
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);

  function loadHistory() {
    return api("/api/scout/history").then(function (body) { setHistory(body.items); }).catch(function (historyError) {
      props.log("warn", "Could not load Scout history", { message: historyError.message });
    });
  }
  useEffect(function () {
    api("/api/scout/config").then(function (body) {
      setConfig(body);
      setSettings(scoutDefaults(body));
      setModel(body.defaultModel);
    }).catch(function (configError) { setError("Could not load Scout settings: " + configError.message); });
    loadHistory();
  }, []);

  if (!config || !settings) return e("div", { className: "scout" }, e("section", { className: "card" }, error ? e("div", { className: "error" }, error) : e("p", { className: "muted" }, "Loading…")));

  const providers = choice === "both" ? ["exa", "tavily"] : [choice];
  const changed = changedSettings(config, settings, providers) + (model !== config.defaultModel ? 1 : 0);

  async function onSubmit(event) {
    event.preventDefault();
    setError("");
    if (query.trim().length < 3) { setError("Type a research question first."); return; }
    setLoading(true);
    setResult(null);
    const payload = { query: query, providers: providers, settings: pickSettings(settings, providers), model: model };
    props.log("info", "Scout search", payload);
    try {
      const body = await api("/api/scout/search", { method: "POST", json: payload });
      setResult(body);
      Object.keys(body.runs).forEach(function (provider) {
        const run = body.runs[provider];
        props.log(run.error ? "error" : "info", "Scout " + PROVIDER_NAMES[provider] + (run.error ? " failed" : " answered"), run.error
          ? { message: run.debug || run.error }
          : { searchMs: run.searchMs, totalMs: run.totalMs, searchCost: run.searchCost, llmCost: run.llmCost, sources: (run.sources || []).length, meta: run.meta });
      });
      if (body.runs.exa) props.onSpend(body.runs.exa.searchCost);
      loadHistory();
    } catch (searchError) {
      setError(searchError.message);
    } finally {
      setLoading(false);
    }
  }

  function openHistory(item) {
    api("/api/scout/searches/" + item.id).then(function (search) {
      setQuery(search.query);
      setChoice(search.providers.length > 1 ? "both" : search.providers[0]);
      setModel(search.model);
      const next = scoutDefaults(config);
      search.providers.forEach(function (provider) { if (search.runs[provider]) next[provider] = Object.assign(next[provider], search.runs[provider].settings); });
      setSettings(next);
      setResult(search);
      setError("");
    }).catch(function (openError) { setError(openError.message); });
  }

  const runs = result ? result.providers.map(function (provider) { return result.runs[provider]; }).filter(Boolean) : [];

  return e("div", { className: "workspace scout " + (result || loading ? "split" : "idle") },
    e("div", { className: "left" },
      e("form", { className: "card", onSubmit: onSubmit },
        e("div", { className: "panel-head" }, e("h2", null, "Scout Research"), e("span", { className: "muted small-text" }, "Research assistant")),
        e("p", { className: "hint", style: { marginTop: 4 } }, "Ask anything a salesperson would want to know before a call. The answer cites its sources."),
        e(Field, { id: "scoutQuery", label: "Research question", value: query, onChange: setQuery, multiline: true, placeholder: "Has Acme had any layoffs recently, who are its main competitors, and has it announced any recent partnerships?" }),
        e("div", { className: "scout-provider" },
          e("span", { className: "label" }, "Search with"),
          e(ProviderSwitch, { config: config, value: choice, disabled: loading, onChange: setChoice })
        ),
        e(OptionsToggle, { open: showOptions, changed: changed, onToggle: function () { setShowOptions(!showOptions); } }),
        showOptions ? e(ScoutOptions, {
          idPrefix: "scout",
          config: config,
          providers: providers,
          settings: settings,
          onSettings: setSettings,
          model: model,
          onModel: setModel,
          disabled: loading,
          onReset: function () { setSettings(scoutDefaults(config)); setModel(config.defaultModel); }
        }) : null,
        e("div", { className: "actions" },
          e("button", { type: "submit", disabled: loading }, loading ? "Researching…" : choice === "both" ? "Ask both" : "Ask"),
          e("span", { className: "estimate" }, "Limits: search " + seconds(config.limits.searchMs) + ", full answer " + seconds(config.limits.totalMs) + ".")
        ),
        error ? e("div", { className: "error", role: "alert" }, error) : null
      ),
      e("section", { className: "card history-card" },
        e("h2", null, "Recent questions"),
        history.length ? e("ul", { className: "history-list" }, history.map(function (item) {
          return e("li", { key: item.id },
            e("button", { type: "button", className: "history-item", disabled: loading, onClick: function () { openHistory(item); } },
              e("span", { className: "history-kind" + (item.providers.length > 1 ? " batch" : "") }, item.providers.length > 1 ? "BOTH" : (PROVIDER_NAMES[item.providers[0]] || "").slice(0, 3).toUpperCase()),
              e("span", { className: "history-label" }, item.query),
              e("span", { className: "muted small-text" }, timeAgo(item.createdAt))
            )
          );
        })) : e("p", { className: "muted small-text" }, "Questions you ask are saved here.")
      )
    ),
    result || loading ? e("div", { className: "side" },
      loading ? e(Pending, { status: choice === "both" ? "Searching Exa and Tavily, then writing both answers…" : "Searching and writing the answer…" }) : null,
      runs.length ? e("div", { className: runs.length > 1 ? "scout-compare" : "" }, runs.map(function (run) {
        return e(ScoutAnswer, { key: run.provider, run: run, limits: config.limits });
      })) : null
    ) : null
  );
}

function ScoutCaseEditor(props) {
  const editing = Boolean(props.caseDef);
  const [id, setId] = useState(editing ? props.caseDef.id : "");
  const [kind, setKind] = useState(editing ? props.caseDef.kind : "");
  const [query, setQuery] = useState(editing ? props.caseDef.query : "");
  const [facts, setFacts] = useState(editing ? props.caseDef.mustInclude.join("\\n") : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const body = { id: id.trim(), kind: kind, query: query, mustInclude: facts.split("\\n") };
    api(editing ? "/api/scout/cases/" + encodeURIComponent(props.caseDef.id) : "/api/scout/cases", { method: editing ? "PUT" : "POST", json: body })
      .then(function (saved) { props.onSaved(saved, editing); })
      .catch(function (saveError) { setError(saveError.message); setSaving(false); });
  }

  return e("form", { className: "case-editor", onSubmit: save },
    e("h3", null, editing ? "Edit " + props.caseDef.id : "New research query"),
    e("div", { className: "grid" },
      e(Field, { id: "scout-case-id", label: "Id", value: id, onChange: setId, placeholder: "stripe-layoffs", readOnly: editing }),
      e(Field, { id: "scout-case-kind", label: "Kind", value: kind, onChange: setKind, placeholder: "layoffs" }),
      e(Field, { id: "scout-case-query", label: "Query", value: query, onChange: setQuery, multiline: true, wide: true, placeholder: "Has Stripe had any layoffs in the past year?" }),
      e(Field, { id: "scout-case-facts", label: "Must-include facts (one per line, optional)", value: facts, onChange: setFacts, multiline: true, wide: true, placeholder: "Only facts you're sure are still true." })
    ),
    e("div", { className: "actions" },
      e("button", { type: "submit", disabled: saving }, saving ? "Saving…" : "Save"),
      e("button", { type: "button", className: "ghost", onClick: props.onCancel }, "Cancel")
    ),
    error ? e("div", { className: "error", role: "alert" }, error) : null
  );
}

function pct(value) {
  return value === null || value === undefined ? "—" : value + "%";
}

function latencyTriple(stats) {
  return stats ? [stats.p50, stats.p95, stats.p99].map(seconds).join(" / ") : "—";
}

function ScoutSummary(props) {
  const summary = props.summary;
  const providers = summary.providers;
  function row(label, valueOf, compare, hint) {
    const values = providers.map(function (provider) { return valueOf(summary.byProvider[provider], provider); });
    let winner = null;
    if (compare && providers.length > 1) {
      const raw = providers.map(function (provider) { return compare(summary.byProvider[provider]); });
      if (raw.every(function (value) { return typeof value === "number"; }) && raw[0] !== raw[1]) winner = raw[0] > raw[1] ? 0 : 1;
    }
    return e("tr", { key: label },
      e("th", { title: hint || "" }, label),
      values.map(function (value, index) { return e("td", { key: index, className: winner === index ? "winner" : "" }, value); })
    );
  }
  function neg(value) { return typeof value === "number" ? -value : value; }
  return e("section", { className: "card" },
    e("div", { className: "panel-head" },
      e("h2", null, "Results"),
      e("span", { className: "muted small-text" }, summary.totalQueries + " queries · answers by " + summary.model + " · graded by " + (summary.judgeModel || "no grader"))
    ),
    e("div", { className: "table-scroll" },
      e("table", { className: "compare scout-summary" },
        e("thead", null, e("tr", null, e("th", null, ""), providers.map(function (provider) { return e("th", { key: provider }, PROVIDER_NAMES[provider]); }))),
        e("tbody", null,
          row("Quality score (0–100)", function (stats) { return stats.quality === null ? "—" : e("b", null, stats.quality); }, function (stats) { return stats.quality; },
            "Weighted grader score: completeness 40%, accuracy 30%, freshness 20%, citations 10%."),
          ["completeness", "accuracy", "freshness", "citations"].map(function (key) {
            return row(key.charAt(0).toUpperCase() + key.slice(1) + " (1–5)", function (stats) { return stats.criteria[key] === null ? "—" : stats.criteria[key]; }, function (stats) { return stats.criteria[key]; });
          }),
          row("False “no” answers", function (stats) { return e("span", { className: stats.falseNegatives ? "bad" : "" }, stats.falseNegatives); }, function (stats) { return neg(stats.falseNegatives); },
            "Answers that said something didn't happen when a source showed it did."),
          row("Must-include facts found", function (stats) { return stats.mustTotal ? stats.mustHits + "/" + stats.mustTotal : "—"; }, function (stats) { return stats.mustTotal ? stats.mustHits / stats.mustTotal : null; }),
          providers.length > 1 ? row("Head-to-head wins", function (stats) { return stats.wins + (summary.ties ? " (" + summary.ties + " ties)" : ""); }, function (stats) { return stats.wins; }) : null,
          row("Search latency p50 / p95 / p99", function (stats) { return latencyTriple(stats.searchMs); }, function (stats) { return neg(stats.searchMs.p95); }),
          row("Searches within " + seconds(props.limits.searchMs), function (stats) { return pct(stats.searchWithinLimit); }, function (stats) { return stats.searchWithinLimit; }),
          row("Full answer p50 / p95 / p99", function (stats) { return latencyTriple(stats.totalMs); }, function (stats) { return neg(stats.totalMs.p95); }),
          row("Answers within " + seconds(props.limits.totalMs), function (stats) { return pct(stats.totalWithinLimit); }, function (stats) { return stats.totalWithinLimit; }),
          row("Search cost per query", function (stats) { return stats.searchCost === null ? "—" : money(stats.searchCost, 4); }, function (stats) { return neg(stats.searchCost); }),
          row("LLM cost per query", function (stats) { return stats.llmCost === null ? "—" : money(stats.llmCost, 4); }, function (stats) { return neg(stats.llmCost); },
            "More or longer page content means more input tokens for the answer LLM."),
          row("Total cost per query", function (stats) { return stats.costPerQuery === null ? "—" : money(stats.costPerQuery, 4); }, function (stats) { return neg(stats.costPerQuery); }),
          row("At " + (props.limits.monthlyQueries / 1e6) + "M queries a month", function (stats) { return stats.monthlyCost === null ? "—" : "$" + Math.round(stats.monthlyCost).toLocaleString(); }, function (stats) { return neg(stats.monthlyCost); }),
          row("Errors", function (stats) { return e("span", { className: stats.errors ? "bad" : "" }, stats.errors + "/" + stats.queries); })
        )
      )
    ),
    summary.byKind && summary.byKind.length ? e("details", { className: "grounding" },
      e("summary", null, "Quality by kind of query"),
      e("table", { className: "compare" },
        e("thead", null, e("tr", null, e("th", null, "Kind"), providers.map(function (provider) { return e("th", { key: provider }, PROVIDER_NAMES[provider]); }))),
        e("tbody", null, summary.byKind.map(function (row) {
          return e("tr", { key: row.kind }, e("th", null, row.kind + (row.queries > 1 ? " (" + row.queries + ")" : "")), providers.map(function (provider) {
            return e("td", { key: provider }, row.quality[provider] === null ? "—" : row.quality[provider]);
          }));
        }))
      )
    ) : null,
    e("p", { className: "muted small-text" }, "Green marks the better value. Search " + money(summary.searchCost, 4) + ", LLM " + money(summary.llmCost, 4) + ", grader " + money(summary.judgeCost, 4) + " for this run.")
  );
}

function ScoutEvalCase(props) {
  const state = props.state;
  const result = state.result;
  const providers = props.providers;
  return e("li", { className: "eval-case" },
    e("details", null,
      e("summary", { className: "eval-row" },
        result ? e("span", { className: "pill pass" }, "Done") : e("span", { className: "pill running" }, e("span", { className: "spinner small" }), "Running"),
        e("span", { className: "eval-summary" }, e("b", null, props.id), " ", e("span", { className: "muted" }, result ? result.query : "")),
        result ? providers.map(function (provider) {
          const run = result.runs[provider];
          const grade = result.grades[provider];
          if (!run) return null;
          return e("span", { key: provider, className: "eval-meta" + (result.better === provider ? " winner" : "") },
            PROVIDER_NAMES[provider] + " " + (run.error ? "error" : (grade ? grade.quality : "—") + " · " + seconds(run.totalMs)));
        }) : null,
        result && result.better === "tie" ? e("span", { className: "eval-meta" }, "tie") : null
      ),
      result ? e("div", { className: providers.length > 1 ? "scout-compare" : "" }, providers.map(function (provider) {
        const run = result.runs[provider];
        return run ? e(ScoutAnswer, { key: provider, run: run, grade: result.grades[provider], mustInclude: result.mustInclude, limits: props.limits }) : null;
      })) : null,
      result && result.judgeError ? e("p", { className: "muted small-text" }, "Grader: " + result.judgeError) : null
    )
  );
}

function ScoutEvals(props) {
  const [config, setConfig] = useState(null);
  const [cases, setCases] = useState([]);
  const [selected, setSelected] = useState({});
  const [editing, setEditing] = useState(null);
  const [useProviders, setUseProviders] = useState({ exa: true, tavily: true });
  const [showOptions, setShowOptions] = useState(false);
  const [settings, setSettings] = useState(null);
  const [model, setModel] = useState("");
  const [judgeModel, setJudgeModel] = useState("");
  const [concurrency, setConcurrency] = useState(3);
  const [running, setRunning] = useState(false);
  const [order, setOrder] = useState([]);
  const [states, setStates] = useState({});
  const [summary, setSummary] = useState(null);
  const [runProviders, setRunProviders] = useState([]);
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]);
  const [startedAt, setStartedAt] = useState(null);
  const [now, setNow] = useState(Date.now());

  function loadCases(first) {
    return api("/api/scout/cases").then(function (body) {
      setCases(body.cases);
      setSelected(function (current) {
        const next = {};
        body.cases.forEach(function (caseDef) { next[caseDef.id] = first || current[caseDef.id] === undefined ? true : current[caseDef.id]; });
        return next;
      });
    }).catch(function (casesError) { setError("Could not load Scout queries: " + casesError.message); });
  }
  function loadRuns() {
    return api("/api/scout/evals/runs").then(function (body) { setHistory(body.runs); }).catch(function (runsError) {
      props.log("warn", "Could not load Scout eval runs", { message: runsError.message });
    });
  }
  useEffect(function () {
    api("/api/scout/config").then(function (body) {
      setConfig(body);
      setSettings(scoutDefaults(body));
      setModel(body.defaultModel);
      setJudgeModel(body.judge.defaultModel);
    }).catch(function (configError) { setError("Could not load Scout settings: " + configError.message); });
    loadCases(true);
    loadRuns();
  }, []);
  useEffect(function () {
    if (!running) return;
    const timer = setInterval(function () { setNow(Date.now()); }, 500);
    return function () { clearInterval(timer); };
  }, [running]);

  if (!config || !settings) return e("div", { className: "evals" }, e("section", { className: "card" }, error ? e("div", { className: "error" }, error) : e("p", { className: "muted" }, "Loading…")));

  const providers = ["exa", "tavily"].filter(function (provider) { return useProviders[provider] && providerConfigured(config, provider); });
  const ids = cases.filter(function (caseDef) { return selected[caseDef.id]; }).map(function (caseDef) { return caseDef.id; });
  const changed = changedSettings(config, settings, providers) + (model !== config.defaultModel ? 1 : 0);
  const shownProviders = runProviders.length ? runProviders : providers;

  function caseSaved(saved, edited) {
    props.log("info", edited ? "Scout query updated" : "Scout query added", { id: saved.id });
    setEditing(null);
    loadCases(false);
  }

  function removeCase(caseDef) {
    if (!window.confirm("Delete the query " + caseDef.id + "? This can't be undone.")) return;
    api("/api/scout/cases/" + encodeURIComponent(caseDef.id), { method: "DELETE" })
      .then(function () { props.log("info", "Scout query deleted", { id: caseDef.id }); loadCases(false); })
      .catch(function (deleteError) { setError(deleteError.message); });
  }

  function clearRuns() {
    if (!window.confirm("Delete all saved Scout eval runs for everyone?")) return;
    api("/api/scout/evals/runs", { method: "DELETE" }).then(function () { setHistory([]); }).catch(function (clearError) { setError(clearError.message); });
  }

  async function runEvals() {
    const calls = ids.length * providers.length;
    if (!window.confirm("Run " + ids.length + " queries on " + providers.map(function (provider) { return PROVIDER_NAMES[provider]; }).join(" and ") + "? That is " + calls + " paid searches and " + calls + " LLM answers, plus one grader call per query.")) return;
    setError("");
    setSummary(null);
    setOrder([]);
    setStates({});
    setRunProviders(providers);
    setRunning(true);
    setStartedAt(Date.now());
    setNow(Date.now());
    const payload = { ids: ids, providers: providers, settings: pickSettings(settings, providers), model: model, judge: config.judge.available, judgeModel: judgeModel, concurrency: concurrency };
    props.log("info", "Scout eval run requested", payload);
    try {
      const response = await fetch("/api/scout/evals/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if ((response.headers.get("Content-Type") || "").indexOf("text/event-stream") === -1) {
        const body = await response.json();
        throw new Error(body.error || "The Scout eval run failed.");
      }
      await readSse(response, function (message) {
        if (message.event === "log") {
          props.addServerLog(message.data);
        } else if (message.event === "case-start") {
          setOrder(function (current) { return current.concat([message.data.id]); });
          setStates(function (current) { const next = Object.assign({}, current); next[message.data.id] = {}; return next; });
        } else if (message.event === "case-result") {
          if (message.data.runs.exa) props.onSpend(message.data.runs.exa.searchCost);
          setStates(function (current) { const next = Object.assign({}, current); next[message.data.id] = { result: message.data }; return next; });
        } else if (message.event === "done") {
          setSummary(message.data);
          loadRuns();
        } else if (message.event === "error") {
          setError(message.data.error || "The Scout eval run failed.");
        }
      });
    } catch (runError) {
      props.log("error", "Scout eval run failed", { message: runError.message });
      setError(runError.message);
    } finally {
      setRunning(false);
      setNow(Date.now());
      props.onFinished();
    }
  }

  function showRun(entry) {
    const next = {};
    entry.results.forEach(function (result) { next[result.id] = { result: result }; });
    setOrder(entry.results.map(function (result) { return result.id; }));
    setStates(next);
    setRunProviders(entry.providers);
    setSummary(entry.summary);
    setStartedAt(null);
  }

  const doneCount = order.filter(function (id) { return states[id] && states[id].result; }).length;

  return e("div", { className: "evals" },
    e("section", { className: "card" },
      e("div", { className: "panel-head" },
        e("h2", null, "Scout evals"),
        e("span", { className: "muted small-text" }, "Each query runs on every selected search API with the same answer LLM. A blind AI grader then scores the answers side by side.")
      ),
      e("table", { className: "cases" },
        e("thead", null, e("tr", null, e("th", null, ""), e("th", null, "Query"), e("th", null, "Kind"), e("th", null, "Question"), e("th", null, "Must include"))),
        e("tbody", null, cases.length ? null : e("tr", null, e("td", { colSpan: 5, className: "muted" }, "No queries yet. Add one below.")), cases.map(function (caseDef) {
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
                e("button", { type: "button", className: "link", disabled: running, onClick: function () { setEditing(caseDef); } }, "Edit"),
                e("button", { type: "button", className: "link danger", disabled: running, onClick: function () { removeCase(caseDef); } }, "Delete"))),
            e("td", { className: "muted" }, caseDef.kind),
            e("td", null, caseDef.query),
            e("td", { className: "muted" }, caseDef.mustInclude.length ? caseDef.mustInclude.join("; ") : "—")
          );
        }))
      ),
      editing
        ? e(ScoutCaseEditor, { key: editing === "new" ? "new" : editing.id, caseDef: editing === "new" ? null : editing, onSaved: caseSaved, onCancel: function () { setEditing(null); } })
        : e("div", { className: "case-add" },
            e("button", { type: "button", className: "ghost", disabled: running, onClick: function () { setEditing("new"); } }, "+ Add query"),
            e("button", { type: "button", className: "link", disabled: running, onClick: function () {
              const all = ids.length !== cases.length;
              const next = {};
              cases.forEach(function (caseDef) { next[caseDef.id] = all; });
              setSelected(next);
            } }, ids.length !== cases.length ? "Select all" : "Select none"),
            e("span", { className: "muted small-text" }, "Queries are saved and shared by everyone.")),
      e("div", { className: "eval-options" },
        ["exa", "tavily"].map(function (provider) {
          const configured = providerConfigured(config, provider);
          return e("label", { key: provider, className: "inline-check", title: configured ? "" : "Add TAVILY_API_KEY on the server to include Tavily." },
            e("input", { type: "checkbox", checked: useProviders[provider] && configured, disabled: running || !configured, onChange: function (event) { const next = Object.assign({}, useProviders); next[provider] = event.target.checked; setUseProviders(next); } }),
            PROVIDER_NAMES[provider],
            configured ? null : e("span", { className: "muted" }, " — no API key yet")
          );
        }),
        config.judge.available ? e("label", { className: "inline-check" }, "Grader ",
          e("select", { value: judgeModel, disabled: running, onChange: function (event) { setJudgeModel(event.target.value); } },
            config.models.map(function (entry) { return e("option", { key: entry.id, value: entry.id }, modelLabel(entry, config.judge.defaultModel)); }))
        ) : e("span", { className: "muted" }, "AI grader not configured"),
        e("label", { className: "inline-check" }, "Run ",
          e("select", { value: concurrency, disabled: running, onChange: function (event) { setConcurrency(Number(event.target.value)); } },
            [1, 2, 3, 4].map(function (n) { return e("option", { key: n, value: n }, n); })),
          " at a time")
      ),
      e(OptionsToggle, { open: showOptions, changed: changed, onToggle: function () { setShowOptions(!showOptions); } }),
      showOptions ? e(ScoutOptions, {
        idPrefix: "scout-eval",
        config: config,
        providers: providers.length ? providers : ["exa"],
        settings: settings,
        onSettings: setSettings,
        model: model,
        onModel: setModel,
        disabled: running,
        onReset: function () { setSettings(scoutDefaults(config)); setModel(config.defaultModel); }
      }) : null,
      e("p", { className: "muted small-text" }, "Grader weights: " + config.criteria.map(function (criterion) { return criterion.label.toLowerCase() + " " + Math.round(criterion.weight * 100) + "%"; }).join(", ") + ". Answers are shuffled and labelled A and B so the grader can't tell which API produced them."),
      e("div", { className: "actions" },
        e("button", { type: "button", disabled: running || !ids.length || !providers.length, onClick: runEvals },
          running ? "Running…" : "Run " + ids.length + " quer" + (ids.length === 1 ? "y" : "ies") + (providers.length ? " on " + providers.map(function (provider) { return PROVIDER_NAMES[provider]; }).join(" + ") : "")),
        e("span", { className: "estimate" }, "Each query is a paid search plus an LLM answer per API.")
      ),
      error ? e("div", { className: "error", role: "alert" }, error) : null
    ),
    order.length || running ? e("section", { className: "card" },
      e("div", { className: "stats" },
        e("div", null, e("span", { className: "stat-label" }, "Done"), e("span", { className: "stat" }, doneCount + "/" + (summary ? summary.totalQueries : order.length || ids.length))),
        startedAt ? e("div", null, e("span", { className: "stat-label" }, "Elapsed"), e("span", { className: "stat" }, Math.round((now - startedAt) / 1000) + "s")) : null,
        shownProviders.map(function (provider) {
          const quality = summary && summary.byProvider[provider] ? summary.byProvider[provider].quality : null;
          return e("div", { key: provider }, e("span", { className: "stat-label" }, PROVIDER_NAMES[provider] + " quality"), e("span", { className: "stat" }, quality === null ? "—" : quality));
        })
      ),
      e("ul", { className: "eval-cases" }, order.map(function (id) {
        return e(ScoutEvalCase, { key: id, id: id, state: states[id] || {}, providers: shownProviders, limits: config.limits });
      }))
    ) : null,
    summary ? e(ScoutSummary, { summary: summary, limits: config.limits }) : null,
    history.length ? e("section", { className: "card" },
      e("div", { className: "panel-head" },
        e("h2", null, "Recent runs"),
        e("button", { type: "button", className: "ghost", onClick: clearRuns }, "Clear")
      ),
      e("ul", { className: "history" }, history.map(function (entry) {
        return e("li", { key: entry.id },
          e("button", { type: "button", className: "link", disabled: running, onClick: function () { showRun(entry); } }, new Date(entry.at).toLocaleString()),
          entry.providers.map(function (provider) {
            const stats = entry.summary.byProvider[provider];
            return e("span", { key: provider, className: "muted" }, PROVIDER_NAMES[provider] + " " + (stats && stats.quality !== null ? stats.quality : "—"));
          }),
          e("span", { className: "muted" }, entry.summary.totalQueries + " queries · " + entry.model)
        );
      })),
      e("p", { className: "muted small-text" }, "Saved for everyone, last 20 runs.")
    ) : null
  );
}
`;
}
