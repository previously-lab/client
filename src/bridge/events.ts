import type { BridgeToolEvent } from './types.js';

/**
 * Protocol-2 event collector with hard caps (design §9: a runaway CLI must
 * never blow up the kernel through an unbounded events array).
 *
 * - At most MAX_BRIDGE_EVENTS events are kept/streamed; the tail is dropped.
 * - The serialized events array stays under MAX_BRIDGE_EVENT_BYTES.
 * - When anything was dropped, finalize() appends one synthetic note event
 *   ("… N more tool events omitted") so the kernel sees an honest gap marker
 *   instead of a silently truncated stream.
 */
export const MAX_BRIDGE_EVENTS = 100;
export const MAX_BRIDGE_EVENT_BYTES = 256 * 1024;

export interface BridgeEventCollector {
  /** Record one derived tool event (streams it live unless capped out). */
  record(event: BridgeToolEvent): void;
  /** The collected events, with the synthetic omission note if capped. */
  finalize(): BridgeToolEvent[];
}

export function createEventCollector(sink?: (event: BridgeToolEvent) => void): BridgeEventCollector {
  const events: BridgeToolEvent[] = [];
  let bytes = 0;
  let dropped = 0;
  return {
    record(event) {
      const size = JSON.stringify(event).length;
      if (events.length >= MAX_BRIDGE_EVENTS || bytes + size > MAX_BRIDGE_EVENT_BYTES) {
        dropped += 1;
        return;
      }
      events.push(event);
      bytes += size;
      sink?.(event);
    },
    finalize() {
      if (dropped > 0) {
        events.push({
          name: 'bridge',
          summary: `… ${dropped} more tool event${dropped === 1 ? '' : 's'} omitted (cap ${MAX_BRIDGE_EVENTS})`,
          status: 'ok',
        });
      }
      return events;
    },
  };
}
