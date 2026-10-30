import { JsonFileStore } from './files.js';
import { SourceError } from './errors.js';

// Prints with no reservation that staff have charged to a member by hand,
// so their filament counts toward that member's usage. Keyed by print id;
// a reservation found later always wins over an assignment.

export const MAX_NAME_LENGTH = 100;
const PRINT_ID = /^[\w.:-]{1,100}$/;

export class AssignmentLog extends JsonFileStore {
  constructor(file) {
    super(file, 'print assignments');
    this.prints = new Map();
  }

  async load() {
    const saved = await this.readJson();
    for (const [id, a] of Object.entries(saved?.prints || {})) {
      if (typeof a?.name === 'string' && a.name) this.prints.set(id, a);
    }
  }

  get(id) {
    return this.prints.get(String(id));
  }

  // Charges a print to `name`, or removes its assignment when `name` is empty.
  set(printId, name, { at }) {
    const id = String(printId ?? '');
    if (!PRINT_ID.test(id)) throw new SourceError('That is not a print id.', { code: 'bad_print' });
    if (name != null && typeof name !== 'string') throw new SourceError('The name must be text.', { code: 'bad_name' });
    const clean = (name || '').replace(/\s+/g, ' ').trim();
    if (clean.length > MAX_NAME_LENGTH) {
      throw new SourceError(`Names can be at most ${MAX_NAME_LENGTH} characters.`, { code: 'bad_name' });
    }
    if (!clean) {
      if (!this.prints.delete(id)) return this.queue;
    } else {
      if (this.prints.get(id)?.name === clean) return this.queue;
      this.prints.set(id, { name: clean, at: new Date(at).toISOString() });
    }
    return this.persist(() => ({ prints: Object.fromEntries([...this.prints.entries()].sort(([a], [b]) => a.localeCompare(b))) }));
  }

  stats() {
    return { prints: this.prints.size, writeError: this.writeError };
  }
}
