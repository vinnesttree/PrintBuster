import fs from 'node:fs/promises';
import path from 'node:path';

// Writes a whole file so a crash never leaves it half written.
export async function writeAtomic(file, text, { mode } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, mode ? { mode } : undefined);
  await fs.rename(tmp, file);
}

// A JSON file saved as a whole on each change, readable only by its owner
// (the saved reservations and usage hold member names).
export class JsonFileStore {
  constructor(file, label) {
    this.file = file;
    this.label = label;
    this.writeError = null;
    this.queue = Promise.resolve();
  }

  // The saved object, or null when there is none. An unreadable file is
  // kept aside rather than overwritten by the next save.
  async readJson() {
    let text;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw new Error(`Cannot read the ${this.label} ${this.file}: ${err.message}`);
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      const aside = `${this.file}.unreadable-${Date.now()}`;
      await fs.rename(this.file, aside).catch(() => {});
      console.warn(`${this.label}: ${this.file} was unreadable (${err.message}); moved it to ${aside}`);
      return null;
    }
  }

  // Queues a save of `toJson()`'s result; failures are kept for stats().
  persist(toJson) {
    this.queue = this.queue.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeAtomic(this.file, `${JSON.stringify(toJson())}\n`, { mode: 0o600 });
        this.writeError = null;
      } catch (err) {
        // Kept in memory; the next save tries again.
        if (this.writeError !== err.message) console.error(`Could not save the ${this.label}: ${err.message}`);
        this.writeError = err.message;
      }
    });
    return this.queue;
  }
}
