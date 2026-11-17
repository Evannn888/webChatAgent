export const MODEL_OPTIONS = [
  { label: 'GPT-6.1 Sol',       provider: 'openai',    model: 'gpt-6.1-sol' },
  { label: 'GPT-6 Astra',       provider: 'openai',    model: 'gpt-6-astra' },
  { label: 'GPT-6 Luna',        provider: 'openai',    model: 'gpt-6-luna' },
  { label: 'Claude Fable 5.2',  provider: 'claude',    model: 'claude-fable-5-2' },
  { label: 'Claude Opus 5.5',   provider: 'claude',    model: 'claude-opus-5-5' },
  { label: 'Claude Sonnet 5.5', provider: 'claude',    model: 'claude-sonnet-5-5' },
  { label: 'Claude Haiku 5.5',  provider: 'claude',    model: 'claude-haiku-5-5' },
  { label: 'Gemini 4 Carbon',   provider: 'gemini',    model: 'gemini-4-carbon' },
  { label: 'Gemini 4 Argon',    provider: 'gemini',    model: 'gemini-4-argon' },
  { label: 'Gemini 4 Hydrogen', provider: 'gemini',    model: 'gemini-4-hydrogen' },
  { label: 'Gemini 3.8 Flash',  provider: 'gemini',    model: 'gemini-3.8-flash' },
  // DeepSeek's model table lists V4 Pro as text-only ("Vision: Not supported").
  { label: 'DeepSeek V4 Pro',   provider: 'deepseek',  model: 'deepseek-v4-pro', vision: false },
  { label: 'DeepSeek Flash',    provider: 'deepseek',  model: 'deepseek-flash' },
];

/** Whether a model accepts image input (all listed models do unless marked `vision: false`). */
export const supportsImages = (model) => model?.vision !== false;

// Chats created before the model list was updated still store these ids.
// Each maps to its closest current model (same provider and tier).
export const LEGACY_MODEL_MAP = {
  'gpt-5.5':                'gpt-6.1-sol',
  'gpt-5.4-mini':           'gpt-6-luna',
  'claude-opus-4-8':        'claude-opus-5-5',
  'claude-sonnet-4-6':      'claude-sonnet-5-5',
  'claude-haiku-4-5':       'claude-haiku-5-5',
  'gemini-3.1-pro-preview': 'gemini-4-carbon',
  'gemini-3.5-flash':       'gemini-3.8-flash',
  'gemini-2.5-flash':       'gemini-3.8-flash',
  'deepseek-v4-flash':      'deepseek-flash',
  'deepseek-reasoner':      'deepseek-v4-pro',
};

/** The selectable model for a stored model id (old ids follow LEGACY_MODEL_MAP), or undefined. */
export function findModel(modelId) {
  const id = LEGACY_MODEL_MAP[modelId] || modelId;
  return MODEL_OPTIONS.find((m) => m.model === id);
}

export const PROVIDERS = [
  { id: 'openai',     label: 'OpenAI',     placeholder: 'sk-...' },
  { id: 'claude',     label: 'Claude',     placeholder: 'sk-ant-...' },
  { id: 'gemini',     label: 'Gemini',     placeholder: 'AIza...' },
  { id: 'deepseek',   label: 'DeepSeek',   placeholder: 'sk-...' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...' },
];

// USD per 1M tokens (standard tier, as of 2026-11).
// Gemini 4 Carbon/Argon rise to $4 / $20 on 2026-12-01; Gemini 3.8 Flash to $1.50 / $7.50 on 2027-01-01.
// DeepSeek uses peak-hour rates (off-peak is half). Claude Haiku 5.5 is the <=100K-prompt rate.
export const TOKEN_PRICING = {
  'gpt-6.1-sol':        { input: 2.00,  output: 10.00 },
  'gpt-6-astra':        { input: 10.00, output: 50.00 },
  'gpt-6-luna':         { input: 0.10,  output: 0.50 },
  'claude-fable-5-2':   { input: 8.00,  output: 40.00 },
  'claude-opus-5-5':    { input: 4.00,  output: 20.00 },
  'claude-sonnet-5-5':  { input: 2.00,  output: 10.00 },
  'claude-haiku-5-5':   { input: 0.10,  output: 0.50 },
  'gemini-4-carbon':    { input: 2.00,  output: 10.00 },
  'gemini-4-argon':     { input: 2.00,  output: 10.00 },
  'gemini-4-hydrogen':  { input: 1.50,  output: 7.50 },
  'gemini-3.8-flash':   { input: 0.75,  output: 3.75 },
  'deepseek-v4-pro':    { input: 1.32,  output: 3.96 },
  'deepseek-flash':     { input: 0.30,  output: 1.20 },
};
