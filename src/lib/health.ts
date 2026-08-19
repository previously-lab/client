import net from 'node:net';
import { sleep } from './sleep.js';

/** True if a TCP connection to host:port succeeds (i.e. something is listening). */
export function isPortOpen(port: number, host: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Poll url until it returns any HTTP response (status code irrelevant — a
 * responding server is a live server) or the timeout elapses.
 */
export async function waitForHealthy(url: string, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      // Not up yet.
    }
    await sleep(intervalMs);
  }
  return false;
}
