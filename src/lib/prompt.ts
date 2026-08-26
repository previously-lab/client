import { createInterface, type Interface } from 'node:readline/promises';

/**
 * Minimal interactive-prompt seam for the init wizard. Zero dependencies —
 * just node:readline/promises behind an injectable interface so tests drive
 * the wizard with scripted answers and no TTY.
 *
 * Rules this enforces: every question has a default (empty answer = default),
 * confirms accept y/n/yes/no in any case, and the interface is always closed.
 */
export interface PromptIO {
  /** Free-form question; returns the trimmed answer or the default. */
  ask(question: string, defaultValue: string): Promise<string>;
  /** Yes/no question; empty answer takes the default. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  close(): void;
}

class ReadlinePromptIO implements PromptIO {
  private rl: Interface;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  async ask(question: string, defaultValue: string): Promise<string> {
    const answer = await this.rl.question(`${question} [${defaultValue}] `);
    const trimmed = answer.trim();
    return trimmed === '' ? defaultValue : trimmed;
  }

  async confirm(question: string, defaultYes: boolean): Promise<boolean> {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    for (;;) {
      const answer = (await this.rl.question(`${question} [${hint}] `)).trim().toLowerCase();
      if (answer === '') return defaultYes;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      console.log('Please answer y or n.');
    }
  }

  close(): void {
    this.rl.close();
  }
}

export function createPromptIO(): PromptIO {
  return new ReadlinePromptIO();
}
