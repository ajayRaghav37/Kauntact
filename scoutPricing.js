// Published per-request prices, so the Ask and Run buttons can estimate a cost before anything is billed.
// Exa: https://exa.ai/docs/admin/pricing (text and highlights are included for the first 10 results; summaries are extra).
// neural and keyword are not listed on their own; auto resolves to them, so they use the auto rate.
// Tavily: basic, fast and ultra-fast are 1 credit, advanced is 2, at $0.008 per credit.
// The LLM figure estimates tokens from the page content the chosen options return. Real bills vary with page length.
export const SCOUT_PRICING = {
  exaBase: {
    instant: 0.004,
    fast: 0.007,
    auto: 0.007,
    neural: 0.007,
    keyword: 0.007,
    "deep-lite": 0.012,
    deep: 0.012,
    "deep-reasoning": 0.015,
  },
  exaIncludedResults: 10,
  exaExtraResult: 0.001,
  exaSummaryPerPage: 0.001,
  tavilyCreditUsd: 0.008,
  tavilyCredits: { basic: 1, advanced: 2, fast: 1, "ultra-fast": 1 },
  charsPerToken: 3,
  promptTokens: 700,
  answerTokens: 2000,
  graderOverheadTokens: 900,
  graderOutputTokens: 800,
  chars: {
    exa: { text: 9000, highlights: 1200, summary: 600 },
    tavily: { snippets: 500, snippetsAdvanced: 800, ultraFast: 400, markdown: 9000 },
  },
};

// spec: { providers, settings, queries, modelPrices: {input, output}, graderPrices|null }
// Helpers stay inside the function: its source is copied into the browser, and a nested function is copied with it.
export function scoutEstimate(spec) {
  function sourceChars(provider, settings) {
    if (provider === "exa") return (SCOUT_PRICING.chars.exa[settings.content] || 0) * settings.numResults;
    if (settings.searchDepth === "ultra-fast") return SCOUT_PRICING.chars.tavily.ultraFast * settings.maxResults;
    if (settings.content === "markdown") return SCOUT_PRICING.chars.tavily.markdown * settings.maxResults;
    const chunk = settings.searchDepth === "advanced" ? SCOUT_PRICING.chars.tavily.snippetsAdvanced : SCOUT_PRICING.chars.tavily.snippets;
    return chunk * settings.chunksPerSource * settings.maxResults;
  }
  function tokensFor(dollarsPerMillion, tokens) {
    return (dollarsPerMillion * tokens) / 1e6;
  }
  const queries = spec.queries || 1;
  const counts = { exa: 0, tavily: 0, llm: 0, grader: 0 };
  const cost = { exa: 0, tavily: 0, llm: 0, grader: 0 };
  let graderTokens = SCOUT_PRICING.graderOverheadTokens;
  spec.providers.forEach(function (provider) {
    const settings = spec.settings[provider];
    const contextTokens = Math.round(sourceChars(provider, settings) / SCOUT_PRICING.charsPerToken);
    const answer = tokensFor(spec.modelPrices.input, SCOUT_PRICING.promptTokens + contextTokens) + tokensFor(spec.modelPrices.output, SCOUT_PRICING.answerTokens);
    counts.llm += queries;
    cost.llm += answer * queries;
    graderTokens += contextTokens + 400;
    if (provider === "exa") {
      const extra = Math.max(0, settings.numResults - SCOUT_PRICING.exaIncludedResults) * SCOUT_PRICING.exaExtraResult;
      const summary = settings.content === "summary" ? settings.numResults * SCOUT_PRICING.exaSummaryPerPage : 0;
      counts.exa += queries;
      cost.exa += ((SCOUT_PRICING.exaBase[settings.type] ?? SCOUT_PRICING.exaBase.auto) + extra + summary) * queries;
    } else {
      counts.tavily += queries;
      cost.tavily += (SCOUT_PRICING.tavilyCredits[settings.searchDepth] || 1) * SCOUT_PRICING.tavilyCreditUsd * queries;
    }
  });
  if (spec.graderPrices && counts.llm) {
    counts.grader = queries;
    cost.grader = (tokensFor(spec.graderPrices.input, graderTokens) + tokensFor(spec.graderPrices.output, SCOUT_PRICING.graderOutputTokens)) * queries;
  }
  return {
    queries: queries,
    counts: counts,
    exa: cost.exa,
    tavily: cost.tavily,
    llm: cost.llm,
    grader: cost.grader,
    total: cost.exa + cost.tavily + cost.llm + cost.grader,
  };
}
