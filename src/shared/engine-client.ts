import { browser } from 'wxt/browser';
import type { EngineOp, EngineOps, EngineResponse } from './protocol';

// Call the engine from any extension page or content script (routes via background).
export async function engine<K extends EngineOp>(op: K, args: EngineOps[K]['args']): Promise<EngineOps[K]['result']> {
  const res: EngineResponse<K> | undefined = await browser.runtime.sendMessage({ to: 'bg', kind: 'engine', req: { op, args } });
  if (!res) throw new Error(`engine ${op}: no response`);
  if (!res.ok) throw new Error(`engine ${op}: ${res.error}`);
  return res.result;
}
