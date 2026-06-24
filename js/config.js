export const MODEL_OPTIONS = [
  { label: 'GPT-5.5',           provider: 'openai',    model: 'gpt-5.5' },
  { label: 'GPT-5.4 Mini',      provider: 'openai',    model: 'gpt-5.4-mini' },
  { label: 'Claude Opus 4.8',   provider: 'claude',    model: 'claude-opus-4-8' },
  { label: 'Claude Sonnet 4.6', provider: 'claude',    model: 'claude-sonnet-4-6' },
  { label: 'Claude Haiku 4.5',  provider: 'claude',    model: 'claude-haiku-4-5' },
  { label: 'Gemini 3.5 Flash',  provider: 'gemini',    model: 'gemini-3.5-flash' },
  { label: 'Gemini 3.1 Pro',    provider: 'gemini',    model: 'gemini-3.1-pro-preview' },
  { label: 'Gemini 2.5 Flash',  provider: 'gemini',    model: 'gemini-2.5-flash' },
  { label: 'DeepSeek V4 Pro',   provider: 'deepseek',  model: 'deepseek-v4-pro' },
  { label: 'DeepSeek V4 Flash', provider: 'deepseek',  model: 'deepseek-v4-flash' },
  { label: 'DeepSeek Reasoner', provider: 'deepseek',  model: 'deepseek-reasoner' },
];

export const PROVIDERS = [
  { id: 'openai',     label: 'OpenAI',     placeholder: 'sk-...' },
  { id: 'claude',     label: 'Claude',     placeholder: 'sk-ant-...' },
  { id: 'gemini',     label: 'Gemini',     placeholder: 'AIza...' },
  { id: 'deepseek',   label: 'DeepSeek',   placeholder: 'sk-...' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...' },
];

export const TOKEN_PRICING = {
  'gpt-5.5':                { input: 2.00,  output: 8.00 },
  'gpt-5.4-mini':           { input: 0.40,  output: 1.60 },
  'claude-opus-4-8':        { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':      { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':       { input: 0.80,  output: 4.00 },
  'gemini-3.5-flash':       { input: 0.15,  output: 0.60 },
  'gemini-3.1-pro-preview': { input: 1.25,  output: 5.00 },
  'gemini-2.5-flash':       { input: 0.15,  output: 0.60 },
  'deepseek-v4-pro':        { input: 0.50,  output: 2.00 },
  'deepseek-v4-flash':      { input: 0.10,  output: 0.40 },
  'deepseek-reasoner':      { input: 0.55,  output: 2.19 },
};
