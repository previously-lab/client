import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { kimiAdapter } from './kimi.js';
import {
  BRIDGE_AGENTS,
  type BridgeAdapter,
  type BridgeAgent,
  type BridgeTask,
  type DispatchOptions,
} from './types.js';

const ADAPTERS: Record<BridgeAgent, BridgeAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
};

export function isBridgeAgent(value: string): value is BridgeAgent {
  return (BRIDGE_AGENTS as string[]).includes(value);
}

export function getAdapter(agent: BridgeAgent): BridgeAdapter {
  return ADAPTERS[agent];
}

/** Dispatch a delegateTask payload to the selected subscription CLI. */
export function dispatchBridgeTask(
  agent: BridgeAgent,
  task: BridgeTask,
  opts: DispatchOptions,
): Promise<string> {
  return ADAPTERS[agent].dispatch(task, opts);
}

export { BRIDGE_AGENTS, BridgeError } from './types.js';
export type { AgentTuning, BridgeAgent, BridgeTask, BridgeToolEvent, DispatchOptions } from './types.js';
export { checkCliPresence, resolveCommandArgv, resolveTimeoutMs } from './runner.js';
export { createEventCollector, MAX_BRIDGE_EVENTS, MAX_BRIDGE_EVENT_BYTES } from './events.js';
