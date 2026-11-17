/** Grove chat models from the Nov 15 catalog. Embedding models are omitted: they cannot write Scout or marketing answers. */
export const DEFAULT_CHAT_MODEL = "claude-haiku-5-5";

export const GROVE_CHAT_MODELS = [
  {
    "id": "claude-fable-5",
    "name": "Claude Fable 5",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 7.4,
    "output": 37,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "Claude Fable 5",
      "claude-fable-5-low",
      "claude-fable-5-low-fast",
      "claude-fable-5-medium",
      "claude-fable-5-medium-fast",
      "claude-fable-5-high"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-fable-5-1",
    "name": "Claude Fable 5.1",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 7.4,
    "output": 37,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "Claude Fable 5.1",
      "claude-fable-5-1-low",
      "claude-fable-5-1-low-fast",
      "claude-fable-5-1-medium",
      "claude-fable-5-1-medium-fast",
      "claude-fable-5-1-high"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-fable-5-2",
    "name": "Claude Fable 5.2",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 5.92,
    "output": 29.6,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "Claude Fable 5.2",
      "claude-fable-5-2-medium",
      "claude-fable-5-2-high",
      "claude-fable-5-2-xhigh",
      "claude-fable-5-2-max",
      "claude-fable-5-2"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-haiku-4-5",
    "name": "Claude Haiku 4.5",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 0.74,
    "output": 3.7,
    "contextLength": 200000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "claude-haiku-4.5",
      "Claude Haiku 4.5",
      "claude-4.5-haiku",
      "claude-4.5-haiku-thinking",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001"
    ],
    "reasoning": "toggle"
  },
  {
    "id": "claude-haiku-5-5",
    "name": "Claude Haiku 5.5",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 0.074,
    "output": 0.37,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "Claude Haiku 5.5",
      "claude-haiku-5-5-thinking-high",
      "claude-haiku-5-5-thinking-high (Auto)",
      "claude-haiku-5-5-thinking-high (Auto Balanced)",
      "claude-haiku-5-5-thinking-high (Auto Intelligence)",
      "claude-haiku-5-5-thinking-low"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-opus-4-5",
    "name": "Claude Opus 4.5",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 5,
    "output": 25,
    "contextLength": 200000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "claude-opus-4.5",
      "Claude Opus 4.5",
      "claude-4.5-opus-high",
      "claude-4.5-opus-high-thinking",
      "claude-opus-4-5",
      "claude-opus-4-5-20251101"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-opus-4-6",
    "name": "Claude Opus 4.6",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 5,
    "output": 25,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "claude-opus-4.6",
      "Claude Opus 4.6",
      "Claude Opus 4.6 (500K)",
      "claude-4.6-opus-low-thinking",
      "claude-4.6-opus-low",
      "claude-4.6-opus-high"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-opus-4-7",
    "name": "Claude Opus 4.7",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 5,
    "output": 25,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "Claude Opus 4.7",
      "Claude Opus 4.7 (500K)",
      "claude-opus-4-7-high",
      "claude-opus-4-7-low",
      "claude-opus-4-7-max",
      "claude-opus-4-7-medium"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-opus-4-8",
    "name": "Claude Opus 4.8",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 3.7,
    "output": 18.5,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "Claude Opus 4.8",
      "claude-opus-4-8-high",
      "claude-opus-4-8-high-fast",
      "claude-opus-4-8-low",
      "claude-opus-4-8-max",
      "claude-opus-4-8-medium"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-opus-5",
    "name": "Claude Opus 5",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 3.7,
    "output": 18.5,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "Claude Opus 5",
      "Fusion (Max): Claude Opus 5",
      "claude-opus-5-low",
      "claude-opus-5-low-fast",
      "claude-opus-5-medium",
      "claude-opus-5-medium-fast"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-opus-5-5",
    "name": "Claude Opus 5.5",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 2.96,
    "output": 14.8,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "Claude Opus 5.5",
      "Fusion (High): Claude Opus 5.5",
      "Fusion (Max): Claude Opus 5.5",
      "Fusion (Standard): Claude Opus 5.5",
      "claude-opus-5-5-low",
      "claude-opus-5-5-low-fast"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-sonnet-4-5",
    "name": "Claude Sonnet 4.5",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 3,
    "output": 15,
    "contextLength": 200000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "claude-sonnet-4.5",
      "Claude Sonnet 4.5",
      "Claude 4.5 Sonnet",
      "claude-4.5-sonnet",
      "claude-4.5-sonnet-thinking",
      "claude-sonnet-4-5"
    ],
    "reasoning": "toggle"
  },
  {
    "id": "claude-sonnet-4-6",
    "name": "Claude Sonnet 4.6",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 3,
    "output": 15,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "claude-sonnet-4.6",
      "Claude Sonnet 4.6",
      "Claude 4.6 Sonnet",
      "Claude Sonnet 4.6 (500K)",
      "claude-4.6-sonnet-high",
      "claude-4.6-sonnet-high-thinking"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-sonnet-5",
    "name": "Claude Sonnet 5",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 1.48,
    "output": 7.4,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "Claude Sonnet 5",
      "Claude Sonnet 5 (500K)",
      "claude-sonnet-5-high",
      "claude-sonnet-5-low",
      "claude-sonnet-5-max",
      "claude-sonnet-5-medium"
    ],
    "reasoning": "effort"
  },
  {
    "id": "claude-sonnet-5-5",
    "name": "Claude Sonnet 5.5",
    "lab": "anthropic",
    "labName": "Anthropic",
    "protocol": "anthropic",
    "input": 1.48,
    "output": 7.4,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "Claude Sonnet 5.5",
      "Fusion (Max): Claude Sonnet 5.5",
      "claude-sonnet-5-5-high",
      "claude-sonnet-5-5-high (Auto Balanced)",
      "claude-sonnet-5-5-high (Auto Intelligence)",
      "claude-sonnet-5-5-low"
    ],
    "reasoning": "effort"
  },
  {
    "id": "cohere-command-a",
    "name": "Cohere Command A",
    "lab": "cohere",
    "labName": "Cohere",
    "protocol": "openai",
    "input": 1.85,
    "output": 7.4,
    "contextLength": 131072,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "cohere-command-a"
    ],
    "reasoning": "toggle"
  },
  {
    "id": "deepseek-v4-flash",
    "name": "DeepSeek V4 Flash",
    "lab": "deepseek",
    "labName": "DeepSeek",
    "protocol": "openai",
    "input": 0.1406,
    "output": 0.3774,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "DeepSeek-V4-Flash",
      "deepseek-v4-flash"
    ],
    "reasoning": "toggle"
  },
  {
    "id": "deepseek-v4-flash-0731",
    "name": "DeepSeek V4 Flash 0731",
    "lab": "deepseek",
    "labName": "DeepSeek",
    "protocol": "openai",
    "input": 0.3256,
    "output": 0.9768,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "DeepSeek-V4-Flash-0731",
      "deepseek-v4-flash-0731"
    ],
    "reasoning": "effort"
  },
  {
    "id": "deepseek-v4.1-flash",
    "name": "DeepSeek V4.1 Flash",
    "lab": "deepseek",
    "labName": "DeepSeek",
    "protocol": "openai",
    "input": 0.27749999999999997,
    "output": 1.1099999999999999,
    "contextLength": 1000000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "FW-DeepSeek-V4.1-Flash",
      "fw-deepseek-v4.1-flash",
      "deepseek-v4p1-flash",
      "accounts/fireworks/models/deepseek-v4p1-flash",
      "DeepSeek V4.1 Flash",
      "deepseek-v4.1-flash"
    ],
    "reasoning": "effort"
  },
  {
    "id": "Kimi-K2.7-Code",
    "name": "Kimi K2.7 Code",
    "lab": "moonshot-ai",
    "labName": "Moonshot AI",
    "protocol": "openai",
    "input": 0.703,
    "output": 2.96,
    "contextLength": 262144,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "FW-Kimi-K2.7-Code",
      "fw-kimi-k2.7-code",
      "kimi-k2p7-code",
      "accounts/fireworks/models/kimi-k2p7-code",
      "Kimi K2.7 Code",
      "kimi-k2.7-code"
    ],
    "reasoning": "effort"
  },
  {
    "id": "kimi-k3",
    "name": "Kimi K3",
    "lab": "moonshot-ai",
    "labName": "Moonshot AI",
    "protocol": "openai",
    "input": 2.2199999999999998,
    "output": 11.1,
    "contextLength": 1048576,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "Kimi-K3",
      "FW-Kimi-K3",
      "fw-kimi-k3",
      "accounts/fireworks/models/kimi-k3",
      "Kimi K3",
      "kimi-k3-low"
    ],
    "reasoning": "toggle"
  },
  {
    "id": "gpt-4.1",
    "name": "GPT-4.1",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 1.48,
    "output": 5.92,
    "contextLength": 1047576,
    "features": [],
    "aliases": [
      "gpt-4.1"
    ],
    "reasoning": null
  },
  {
    "id": "gpt-4.1-mini",
    "name": "GPT-4.1 Mini",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 0.296,
    "output": 1.184,
    "contextLength": 1047576,
    "features": [],
    "aliases": [
      "gpt-4.1-mini"
    ],
    "reasoning": null
  },
  {
    "id": "gpt-4o",
    "name": "GPT-4o",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 2.035,
    "output": 8.14,
    "contextLength": 128000,
    "features": [],
    "aliases": [
      "gpt-4o"
    ],
    "reasoning": null
  },
  {
    "id": "gpt-4o-mini",
    "name": "GPT-4o Mini",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 0.1221,
    "output": 0.4884,
    "contextLength": 128000,
    "features": [],
    "aliases": [
      "gpt-4o-mini"
    ],
    "reasoning": null
  },
  {
    "id": "gpt-5-codex",
    "name": "GPT-5 Codex",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 0.925,
    "output": 7.4,
    "contextLength": 400000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "gpt-5-codex-high",
      "gpt-5-codex-high-fast",
      "gpt-5-codex"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-5.2",
    "name": "GPT-5.2",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 1.295,
    "output": 10.36,
    "contextLength": 400000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-5.2",
      "GPT 5.2",
      "gpt-5.2-high",
      "gpt-5.2-low",
      "gpt-5.2-xhigh",
      "gpt-5.2"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-5.3-codex",
    "name": "GPT-5.3 Codex",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 1.295,
    "output": 10.36,
    "contextLength": 400000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-5.3-Codex",
      "gpt-5.3-codex-fast",
      "gpt-5.3-codex-high",
      "gpt-5.3-codex-high-fast",
      "gpt-5.3-codex-low",
      "gpt-5.3-codex-spark-preview-xhigh"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-5.4",
    "name": "GPT-5.4",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 1.85,
    "output": 11.1,
    "contextLength": 1050000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-5.4",
      "GPT 5.4",
      "gpt-5.4-high",
      "gpt-5.4-high-1m",
      "gpt-5.4-high-fast",
      "gpt-5.4-low"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-5.4-mini",
    "name": "GPT-5.4 Mini",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 0.5549999999999999,
    "output": 3.33,
    "contextLength": 400000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-5.4 mini",
      "GPT 5.4 Mini",
      "gpt-5.4-mini-low",
      "gpt-5.4-mini-medium",
      "gpt-5.4-mini-high",
      "gpt-5.4-mini-xhigh"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-5.4-nano",
    "name": "GPT-5.4 Nano",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 0.148,
    "output": 0.925,
    "contextLength": 400000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "gpt-5.4-nano-high",
      "gpt-5.4-nano-low",
      "gpt-5.4-nano-medium",
      "gpt-5.4-nano"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-5.5",
    "name": "GPT-5.5",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 3.7,
    "output": 22.2,
    "contextLength": 1050000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-5.5",
      "GPT 5.5",
      "gpt-5.5-extra-high",
      "gpt-5.5-extra-high-fast",
      "gpt-5.5-high-fast",
      "gpt-5.5-high"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-5.6-luna",
    "name": "GPT-5.6 Luna",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 0.148,
    "output": 0.888,
    "contextLength": 1050000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-5.6-Luna",
      "GPT-5.6 Luna",
      "Fusion (Max): GPT-5.6 Luna",
      "GPT 5.6 Luna",
      "GPT 5.6 Luna (No Thinking)",
      "gpt-5.6-luna-low"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-5.6-sol",
    "name": "GPT-5.6 Sol",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 3.7,
    "output": 22.2,
    "contextLength": 1050000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-5.6-Sol",
      "GPT-5.6 Sol",
      "Fusion (Max): GPT-5.6 Sol",
      "GPT 5.6 Sol",
      "gpt-5.6-sol-none",
      "gpt-5.6-sol-low"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-5.6-terra",
    "name": "GPT-5.6 Terra",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 1.48,
    "output": 8.879999999999999,
    "contextLength": 1050000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-5.6-Terra",
      "GPT-5.6 Terra",
      "Fusion (Max): GPT-5.6 Terra",
      "GPT 5.6 Terra",
      "GPT-5.6 Terra (Auto Intelligence)",
      "GPT-5.6 Terra (Auto Balanced)"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-6-astra",
    "name": "GPT-6 Astra",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 7.4,
    "output": 37,
    "contextLength": 1050000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-6 Astra",
      "Fusion (High): GPT-6 Astra",
      "Fusion (Max): GPT-6 Astra",
      "gpt-6-astra"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-6-luna",
    "name": "GPT-6 Luna",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 0.074,
    "output": 0.37,
    "contextLength": 1050000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-6 Luna",
      "Fusion (High): GPT-6 Luna",
      "Fusion (Max): GPT-6 Luna",
      "Fusion (Standard): GPT-6 Luna",
      "gpt-6-luna-medium",
      "gpt-6-luna"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-6-sol",
    "name": "GPT-6 Sol",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 1.48,
    "output": 7.4,
    "contextLength": 1050000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-6 Sol",
      "Fusion (Max): GPT-6 Sol",
      "gpt-6-sol"
    ],
    "reasoning": "effort"
  },
  {
    "id": "gpt-6.1-sol",
    "name": "GPT-6.1 Sol",
    "lab": "openai",
    "labName": "OpenAI",
    "protocol": "openai",
    "input": 1.48,
    "output": 7.4,
    "contextLength": 1050000,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "GPT-6.1 Sol",
      "Fusion (High): GPT-6.1 Sol",
      "Fusion (Standard): GPT-6.1 Sol",
      "gpt-6.1-sol"
    ],
    "reasoning": "effort"
  },
  {
    "id": "glm-5.3",
    "name": "GLM 5.3",
    "lab": "zai",
    "labName": "Z.ai",
    "protocol": "openai",
    "input": 1.295,
    "output": 4.07,
    "contextLength": 1048575,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "FW-GLM-5.3",
      "fw-glm-5.3",
      "glm-5p3",
      "accounts/fireworks/models/glm-5p3",
      "glm-latest",
      "glm-5p3-high"
    ],
    "reasoning": "effort"
  },
  {
    "id": "glm-5.3-flash",
    "name": "GLM 5.3 Flash",
    "lab": "zai",
    "labName": "Z.ai",
    "protocol": "openai",
    "input": 0.13912,
    "output": 0.4625,
    "contextLength": 1048573,
    "features": [
      "reasoning"
    ],
    "aliases": [
      "FW-GLM-5.3-Flash",
      "fw-glm-5.3-flash",
      "glm-5p3-flash",
      "accounts/fireworks/models/glm-5p3-flash",
      "GLM-5.3 Flash (Fireworks)",
      "glm-flash-latest"
    ],
    "reasoning": "effort"
  }
];

const BY_ID = new Map(GROVE_CHAT_MODELS.map((model) => [model.id, model]));

export function groveModel(id) {
  return BY_ID.get(id) || null;
}

export function modelPrices(id) {
  const model = groveModel(id);
  return model ? { input: model.input ?? 0, output: model.output ?? 0 } : { input: 0, output: 0 };
}

export function graderCost(modelId, usage) {
  if (!usage) return 0;
  const prices = modelPrices(modelId);
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return (input * prices.input + output * prices.output) / 1e6;
}

export function judgeConfigured() {
  return Boolean(process.env.GROVE_API_KEY && process.env.GROVE_ENDPOINT);
}

function anthropicEndpoint() {
  return process.env.GROVE_ENDPOINT;
}

function openaiEndpoint() {
  if (process.env.GROVE_OPENAI_ENDPOINT) return process.env.GROVE_OPENAI_ENDPOINT;
  const anthropic = anthropicEndpoint() || "";
  if (/\/anthropic\/v1\/messages\/?$/i.test(anthropic)) {
    return anthropic.replace(/\/anthropic\/v1\/messages\/?$/i, "/openai/v1/chat/completions");
  }
  return "";
}

function normalizeUsage(usage, protocol) {
  if (!usage) return null;
  if (protocol === "openai") {
    return {
      input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
    };
  }
  return usage;
}

async function callAnthropic({ model, system, prompt, maxTokens, timeoutMs, signal }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(anthropicEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "api-key": process.env.GROVE_API_KEY,
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`LLM request failed (${response.status}${body?.error?.message ? `: ${body.error.message}` : ""})`);
  const text = (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("").trim();
  if (!text) throw new Error(`LLM returned no text (stop reason: ${body.stop_reason ?? "unknown"})`);
  return { text, usage: normalizeUsage(body.usage, "anthropic"), stopReason: body.stop_reason ?? null, protocol: "anthropic" };
}

async function callOpenAI({ model, system, prompt, maxTokens, timeoutMs, signal }) {
  const endpoint = openaiEndpoint();
  if (!endpoint) {
    const error = new Error("No OpenAI Grove endpoint is configured. Set GROVE_OPENAI_ENDPOINT, or keep GROVE_ENDPOINT on the Anthropic messages URL so the OpenAI path can be derived.");
    error.statusCode = 503;
    throw error;
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.GROVE_API_KEY,
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || body?.message || "";
    throw new Error(`LLM request failed (${response.status}${message ? `: ${message}` : ""})`);
  }
  const choice = body.choices?.[0];
  const text = String(choice?.message?.content ?? "").trim();
  if (!text) throw new Error(`LLM returned no text (finish reason: ${choice?.finish_reason ?? "unknown"})`);
  return {
    text,
    usage: normalizeUsage(body.usage, "openai"),
    stopReason: choice?.finish_reason ?? null,
    protocol: "openai",
  };
}

export async function callGrove({ model, system, prompt, maxTokens, timeoutMs, signal }) {
  if (!judgeConfigured()) {
    const error = new Error("GROVE_API_KEY or GROVE_ENDPOINT is not set, so answers can't be written.");
    error.statusCode = 503;
    throw error;
  }
  const entry = groveModel(model);
  if (!entry) {
    const error = new Error(`Unknown model: ${model}`);
    error.statusCode = 400;
    throw error;
  }
  if (entry.protocol === "anthropic") {
    return callAnthropic({ model, system, prompt, maxTokens, timeoutMs, signal });
  }
  return callOpenAI({ model, system, prompt, maxTokens, timeoutMs, signal });
}

export function checkChatModel(model) {
  if (!groveModel(model)) {
    const error = new Error(`model must be one of the Grove chat models`);
    error.statusCode = 400;
    throw error;
  }
  return model;
}

export function publicModels() {
  return GROVE_CHAT_MODELS.map(({ id, name, lab, labName, protocol, input, output, contextLength, features, aliases, reasoning }) => ({
    id, name, lab, labName, protocol, input, output, contextLength, features, aliases, reasoning,
  }));
}
