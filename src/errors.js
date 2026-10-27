// An error from one of the upstream sources. `code` is machine-readable for
// the UI; `hint` tells the operator what to change.
export class SourceError extends Error {
  constructor(message, { code = 'error', hint = '', status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SourceError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

export function describeError(err) {
  if (err instanceof SourceError) {
    return { message: err.message, code: err.code, hint: err.hint || undefined };
  }
  const cause = err?.cause?.code || err?.cause?.message;
  return {
    message: cause ? `${err.message} (${cause})` : String(err?.message || err),
    code: 'error',
  };
}
