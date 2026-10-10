export { classifyPrompt, type AskpassPromptKind, type ClassifiedPrompt } from './prompt';
export {
  AskpassServer,
  type AskpassPromptHandler,
  type AskpassRequest,
  type AskpassServerOptions,
} from './server';
export { ASKPASS_MAIN_SOURCE, writeAskpassShims, type AskpassShimOptions, type AskpassShims } from './shims';
