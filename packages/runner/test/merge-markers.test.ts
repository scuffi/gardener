import { describe, expect, it, vi } from "vitest";
import { ConflictMarkerScanner, hasConflictMarkerLine } from "../src/merge-markers";

const encode = (text: string) => new TextEncoder().encode(text);

/** Feeds `chunks` through one scanner and returns `finish()`. */
function scan(...chunks: string[]): boolean {
  const scanner = new ConflictMarkerScanner();
  for (const chunk of chunks) scanner.push(encode(chunk));
  return scanner.finish();
}

/** Every way to cut `text` into two chunks, plus each cut with an empty chunk between the halves. */
function splits(text: string): string[][] {
  const result: string[][] = [];
  for (let at = 0; at <= text.length; at += 1) {
    result.push([text.slice(0, at), text.slice(at)]);
    result.push([text.slice(0, at), "", text.slice(at)]);
  }
  return result;
}

describe("hasConflictMarkerLine", () => {
  it("finds an ours or theirs marker followed by a space, a CR, or the end of the line", () => {
    for (const text of [
      "<<<<<<< HEAD\n",
      ">>>>>>> main\n",
      "a\n<<<<<<<\nb\n",
      "a\r\n>>>>>>>\r\nb\r\n",
      "<<<<<<<",
      "a\n>>>>>>> main",
      "a\n<<<<<<<\r",
    ]) {
      expect(hasConflictMarkerLine(encode(text)), JSON.stringify(text)).toBe(true);
    }
  });

  it("ignores eight characters, an indented marker, a separator, and other look-alikes", () => {
    for (const text of [
      "",
      "\n\n",
      "<<<<<<<<\n",
      ">>>>>>>>\n",
      " <<<<<<< HEAD\n",
      "\t>>>>>>> main\n",
      "=======\n",
      "a\n=======\nb\n",
      "<<<<<<\n",
      "<<<<<<>\n",
      "<<<<<<<x\n",
      "<<<<<<<\r\r\n",
      "<<<<<<<\rx\n",
      "<<<<<<<\tHEAD\n",
    ]) {
      expect(hasConflictMarkerLine(encode(text)), JSON.stringify(text)).toBe(false);
    }
  });
});

describe("ConflictMarkerScanner", () => {
  it("gives the single-push answer for every split of a marker line", () => {
    for (const text of [
      "a\n<<<<<<< x\nb\n",
      "a\n>>>>>>>\nb",
      "a\r\n<<<<<<<\r\nb\r\n",
      "a\n<<<<<<<<\nb\n",
      " <<<<<<< x\n",
      "x\n=======\n",
    ]) {
      const whole = hasConflictMarkerLine(encode(text));
      for (const chunks of splits(text)) expect(scan(...chunks), JSON.stringify(chunks)).toBe(whole);
    }
  });

  it("splits a marker inside its seven characters", () => {
    expect(scan("<<<", "<<<< x\n")).toBe(true);
    expect(scan(">>>>>>", ">", "\n")).toBe(true);
  });

  it("reads a lone carriage return in the next chunk as the end of a CRLF marker line", () => {
    expect(scan("a\r\n<<<<<<<", "\r", "\nb\r\n")).toBe(true);
    expect(scan("<<<<<<<", "\r\n")).toBe(true);
    // A carriage return that is not the last byte of the line is content.
    expect(scan("<<<<<<<", "\r", "x\n")).toBe(false);
  });

  it("ignores empty chunks", () => {
    expect(scan("", "<<<<<<<", "", "", " x", "", "\n")).toBe(true);
    expect(scan("", "")).toBe(false);
  });

  it("ends a final line with no trailing newline in finish()", () => {
    const scanner = new ConflictMarkerScanner();
    scanner.push(encode("a\n>>>>>>>"));
    expect(scanner.finish()).toBe(true);
    expect(scan("a\n", ">>>>", ">>>")).toBe(true);
    expect(scan("a\n>>>>>>>>")).toBe(false);
  });

  it("keeps a hit: pushes after it are no-ops and finish() stays true", () => {
    const scanner = new ConflictMarkerScanner();
    scanner.push(encode("<<<<<<< HEAD\n"));
    // Without the early return this would start a fresh line and then end it
    // as an ordinary one; the result must not change either way.
    scanner.push(encode("ordinary\n"));
    scanner.push(encode("x".repeat(100)));
    expect(scanner.finish()).toBe(true);
    // A no-op does not even look at the chunk.
    const after = encode("<<<<<<< again\n");
    const indexOf = vi.spyOn(after, "indexOf");
    scanner.push(after);
    expect(indexOf).not.toHaveBeenCalled();
    expect(scanner.finish()).toBe(true);
  });

  it("decides a very long line by its first bytes, however it is chunked", () => {
    // `#head` is private. Its bound is observed through the array pushes one
    // long line causes: at most nine, however long the line.
    const bounded = new ConflictMarkerScanner();
    const line = encode(`<<<<<<< ${"z".repeat(10_000)}`);
    // A hand-rolled counter: a vitest spy on Array.prototype.push recurses.
    const original = Array.prototype.push;
    let pushes = 0;
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      pushes += 1;
      return original.apply(this, items);
    };
    try {
      bounded.push(line);
      bounded.push(line);
    } finally {
      Array.prototype.push = original;
    }
    expect(pushes).toBe(9);
    expect(bounded.finish()).toBe(true);
    // Its effect is shown by behaviour too: a long tail,
    // even one that itself looks like a marker, cannot change the decision
    // the first nine bytes made.
    const tail = "<<<<<<< ".repeat(20_000);
    expect(scan(`<<<<<<< ${tail}\n`)).toBe(true);
    expect(scan(`<<<<<<<<${tail}\n`)).toBe(false);
    expect(scan(`x${tail}\n`)).toBe(false);
    const scanner = new ConflictMarkerScanner();
    scanner.push(encode("x"));
    for (let index = 0; index < 1_000; index += 1) scanner.push(encode(">>>>>>> "));
    scanner.push(encode("\n>>>>>>>"));
    expect(scanner.finish()).toBe(true);
    // A long line with no marker leaves no state for the next line.
    expect(scan(`${"y".repeat(200_000)}\n`, "<<<<<<<", "\n")).toBe(true);
    expect(scan(`${"y".repeat(200_000)}\n`, "<<<<<<<<", "\n")).toBe(false);
  });
});
