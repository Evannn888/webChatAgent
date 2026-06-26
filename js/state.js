import { MODEL_OPTIONS } from './config.js?v=2';

export const state = {
  user: null, 
  messages: [], 
  currentModel: MODEL_OPTIONS[0],
  isGenerating: false, 
  error: null, 
  files: [],
  sessions: [], 
  currentSessionId: null,
};

let msgIdCounter = 0;
export const nextId = () => `msg_${++msgIdCounter}`;

export let activeStream = null;
export const setActiveStream = (stream) => { activeStream = stream; };
