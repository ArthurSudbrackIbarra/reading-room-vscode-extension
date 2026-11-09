import type { ViewerToHost, WebviewPersistedState } from '../src/shared/messages';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(message: ViewerToHost): void {
  api.postMessage(message);
}

export function getState(): WebviewPersistedState | undefined {
  return api.getState() as WebviewPersistedState | undefined;
}

export function setState(state: WebviewPersistedState): void {
  api.setState(state);
}

export function log(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'log', level, message });
}
