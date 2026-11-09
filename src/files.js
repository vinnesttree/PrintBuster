import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// Saved data holds member names, print titles and credentials: files are
// readable only by their owner, and folders made for them only by it too.
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

// Makes the folder a data file goes in. A folder that already exists keeps
// its permissions, since it may be a mounted volume set up on purpose.
export function ensureDir(file) {
  return fs.mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
}

// Makes an existing file readable only by its owner: a mode passed when
// writing applies only when a file is created, so older files keep theirs.
// Only a file this process owns is changed, and never when running as root,
// which could leave a file the usual user can no longer read. On folders
// with access control lists a mode change can take away access the list
// gave, so the old mode is put back if this process lost access. Fails
// quietly, e.g. when the file is missing.
export async function restrictFile(file) {
  try {
    const me = process.getuid?.();
    const { mode, uid } = await fs.stat(file);
    if (!(mode & 0o077) || me === undefined || me === 0 || uid !== me) return;
    await fs.chmod(file, mode & 0o700);
    try {
      await fs.access(file, constants.R_OK | constants.W_OK);
    } catch {
      await fs.chmod(file, mode & 0o7777);
    }
  } catch {
    // Nothing to restrict.
  }
}

// Each write gets its own temporary file, so two writes of the same file
// can never share one.
let tmpSeq = 0;

// Writes a whole file so a crash never leaves it half written. It replaces
// the file rather than writing into it, so it only needs to be able to
// write to the folder: a file left by another user (say, root) is replaced
// with one this process owns.
export async function writeAtomic(file, text, { mode } = {}) {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    await fs.writeFile(tmp, text, mode ? { mode } : undefined);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// A JSON file saved as a whole on each change, readable only by its owner
// (the saved reservations and usage hold member names). With no file (demo
// mode) it is kept in memory only.
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
    if (!this.file) return null;
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
      // It still holds whatever the file held (member names, say).
      await restrictFile(aside);
      console.warn(`${this.label}: ${this.file} was unreadable (${err.message}); moved it to ${aside}`);
      return null;
    }
  }

  // Queues a save of `toJson()`'s result; failures are kept for stats().
  persist(toJson) {
    if (!this.file) return this.queue;
    this.queue = this.queue.then(async () => {
      try {
        await ensureDir(this.file);
        await writeAtomic(this.file, `${JSON.stringify(toJson())}\n`, { mode: PRIVATE_FILE_MODE });
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
