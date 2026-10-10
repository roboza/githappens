/// <reference types="vite/client" />
import type { GitHappensApi } from '../../shared/ipc/contract';

declare global {
  interface Window {
    api: GitHappensApi;
  }
}

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
