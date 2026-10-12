/**
 * Conflict-marker detection for merge commits.
 *
 * A merge commit may not carry a line that starts a content conflict's ours
 * or theirs side: `<<<<<<<` or `>>>>>>>`, followed by a space or the end of
 * the line. `=======` is deliberately not a marker here, because it is common
 * in ordinary text (Markdown headings, banners) and never appears without the
 * other two in a conflict git wrote. The planning capture and the apply job
 * both use this one definition, so they cannot disagree about a file.
 */

const LESS = 0x3c;
const GREATER = 0x3e;
const SPACE = 0x20;
const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;
const MARKER_LENGTH = 7;

/** Streams bytes and remembers whether any complete line was a conflict marker. */
export class ConflictMarkerScanner {
  /** The first bytes of the current line; a marker is decided by at most nine. */
  #head: number[] = [];
  #length = 0;
  #found = false;

  push(chunk: Uint8Array): void {
    if (this.#found) return;
    let start = 0;
    while (start <= chunk.length) {
      const end = chunk.indexOf(LINE_FEED, start);
      const stop = end < 0 ? chunk.length : end;
      for (let index = start; index < stop && this.#head.length < MARKER_LENGTH + 2; index += 1) this.#head.push(chunk[index]!);
      this.#length += stop - start;
      if (end < 0) return;
      this.#endLine();
      if (this.#found) return;
      start = end + 1;
    }
  }

  /** Ends the last line, which need not end with a newline, and reports the result. */
  finish(): boolean {
    if (!this.#found && this.#length > 0) this.#endLine();
    return this.#found;
  }

  #endLine(): void {
    if (isMarkerLine(this.#head, this.#length)) this.#found = true;
    this.#head = [];
    this.#length = 0;
  }
}

function isMarkerLine(head: readonly number[], length: number): boolean {
  if (length < MARKER_LENGTH) return false;
  const first = head[0];
  if (first !== LESS && first !== GREATER) return false;
  for (let index = 1; index < MARKER_LENGTH; index += 1) if (head[index] !== first) return false;
  if (length === MARKER_LENGTH || head[MARKER_LENGTH] === SPACE) return true;
  // A CRLF file ends the marker line with a carriage return.
  return length === MARKER_LENGTH + 1 && head[MARKER_LENGTH] === CARRIAGE_RETURN;
}

/** Whether `bytes` holds a conflict-marker line. */
export function hasConflictMarkerLine(bytes: Uint8Array): boolean {
  const scanner = new ConflictMarkerScanner();
  scanner.push(bytes);
  return scanner.finish();
}
