import { useEffect, useRef } from "react";

export interface GardenPointer {
  column: number;
  row: number;
  strength: number;
}

export interface AsciiGardenOptions {
  columns: number;
  rows: number;
  timeMs: number;
  seed: number;
  depth?: number;
  pointer?: GardenPointer;
}

export interface AsciiGardenScene {
  field: string;
  blooms: readonly [string, string, string, string];
}

const MIN_COLUMNS = 24;
const MAX_COLUMNS = 220;
const MIN_ROWS = 8;
const MAX_ROWS = 24;

function unit(seed: number, column: number, salt: number): number {
  let value = Math.imul(column + 1, 0x45d9f3b) ^ Math.imul(seed + salt, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function createPageSeed(): number {
  try {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return value[0]!;
  } catch {
    return (Date.now() ^ Math.floor((globalThis.performance?.now() ?? 0) * 1_000)) >>> 0;
  }
}

export function renderAsciiGardenScene({ columns, rows, timeMs, seed, depth = 1, pointer }: AsciiGardenOptions): AsciiGardenScene {
  const width = clamp(Math.floor(columns), MIN_COLUMNS, MAX_COLUMNS);
  const height = clamp(Math.floor(rows), MIN_ROWS, MAX_ROWS);
  const field = Array.from({ length: height }, () => Array<string>(width).fill(" "));
  const bloomFields = Array.from({ length: 4 }, () => Array.from({ length: height }, () => Array<string>(width).fill(" ")));
  const elapsed = timeMs / 1_000;
  const density = .58 + depth * .24;
  const tallest = Math.max(2, Math.min(6, Math.floor(height * (.13 + depth * .12))));
  const put = (row: number, column: number, glyph: string) => {
    if (row >= 0 && row < height && column >= 0 && column < width) field[row]![column] = glyph;
  };
  const putBloom = (row: number, column: number, glyph: string, tone: number) => {
    put(row, column, glyph);
    if (row >= 0 && row < height && column >= 0 && column < width) bloomFields[tone]![row]![column] = glyph;
  };
  const leanAt = (column: number, plantHeight: number, phase = 0) => {
    const ambient = Math.sin(elapsed * .68 + column * .145 + seed + phase) * .46
      + Math.sin(elapsed * .27 + column * .051 + seed * .37 + phase * .43) * .2;
    let disturbance = 0;
    if (pointer?.strength) {
      const tipRow = height - plantHeight;
      const deltaColumn = column - pointer.column;
      const deltaRow = (tipRow - pointer.row) * 1.65;
      const radius = 9 + depth * 4;
      const distanceSquared = deltaColumn * deltaColumn + deltaRow * deltaRow;
      if (distanceSquared <= radius * radius * 2.25) {
        const influence = Math.exp(-distanceSquared / (radius * radius));
        const direction = deltaColumn === 0 ? (unit(seed, column, 29) > .5 ? 1 : -1) : Math.sign(deltaColumn);
        disturbance = direction * influence * pointer.strength * 1.55;
      }
    }
    return clamp((ambient + disturbance) * (.55 + depth * .18), -1.2, 1.2);
  };

  for (let column = 0; column < width; column += 1) {
    const presence = unit(seed, column, 3);
    if (presence > density) continue;
    const bladeHeight = 1 + Math.floor(unit(seed, column, 11) * tallest);
    const lean = leanAt(column, bladeHeight);

    for (let segment = 0; segment < bladeHeight; segment += 1) {
      const row = height - 2 - segment;
      const progress = (segment + 1) / bladeHeight;
      const curve = lean * Math.pow(progress, 1.65);
      const offset = Math.round(curve * segment * .22);
      const target = column + offset;
      if (row < 0 || target < 0 || target >= width) continue;
      const tip = segment === bladeHeight - 1;
      const stem = segment === 0 ? "|" : curve < -.34 ? "\\" : curve > .34 ? "/" : "|";
      field[row]![target] = tip ? (lean < -.14 ? "\\" : lean > .14 ? "/" : "'") : stem;
    }

    if (bladeHeight > 1 && unit(seed, column, 31) < .3) {
      const side = unit(seed, column, 37) > .5 ? 1 : -1;
      const tuftColumn = column + side;
      if (tuftColumn >= 0 && tuftColumn < width && field[height - 2]![tuftColumn] === " ") {
        field[height - 2]![tuftColumn] = side > 0 ? "/" : "\\";
      }
    }

    field[height - 1]![column] = presence < .24 ? "," : presence < .52 ? "." : "'";
  }

  for (let column = 0; column < width; column += 1) {
    if (field[height - 1]![column] === " " && unit(seed, column, 41) < .4 + depth * .18) {
      field[height - 1]![column] = unit(seed, column, 43) > .5 ? "." : ",";
    }
  }

  let bloomOrdinal = 0;
  if (depth > .72) for (let column = 2; column < width - 2; column += 1) {
    const rarity = unit(seed, column, 71);
    if (rarity >= .12) continue;
    let localMinimum = true;
    for (let neighbor = Math.max(1, column - 3); neighbor <= Math.min(width - 2, column + 3); neighbor += 1) {
      if (neighbor !== column && unit(seed, neighbor, 71) < rarity) localMinimum = false;
    }
    if (!localMinimum) continue;

    const species = unit(seed, column, 79);
    const shape = unit(seed, column, 83);
    const kind = species < .38 ? "flower" : species < .5 ? "bud" : species < .68 ? "seed" : species < .88 ? "weed" : "clover";
    const maximumHeight = kind === "clover" ? 3 : kind === "weed" ? 6 : kind === "seed" ? 7 : kind === "bud" ? 6 : 9;
    const minimumHeight = kind === "clover" ? 2 : kind === "weed" ? 3 : kind === "seed" ? 5 : kind === "bud" ? 4 : 6;
    const plantHeight = Math.min(height - 3, minimumHeight + Math.floor(unit(seed, column, 89) * (maximumHeight - minimumHeight + 1)));
    const lean = leanAt(column, plantHeight, species * 4);
    const positions: Array<{ row: number; column: number }> = [];

    for (let segment = 0; segment < plantHeight; segment += 1) {
      const progress = (segment + 1) / plantHeight;
      const curve = lean * Math.pow(progress, 1.5);
      const target = column + Math.round(curve * segment * .2);
      const row = height - 2 - segment;
      positions.push({ row, column: target });
      put(row, target, segment > 0 && curve < -.38 ? "\\" : segment > 0 && curve > .38 ? "/" : "|");
    }

    const tip = positions.at(-1)!;
    const middle = positions[Math.max(1, Math.floor(positions.length * .45))]!;
    if (kind === "flower") {
      const tone = (Math.abs(seed) + bloomOrdinal * 3) % 4;
      bloomOrdinal += 1;
      const patterns = [
        ["\\|/", "-o-", "/|\\"],
        ["\\./", "-*-", "/.\\"],
        [".-.", "(o)", "'-'"],
        ["\\_/", "(+)", "/|\\"],
        ["\\ | /", "-(@)-", "/ | \\"],
        [" . ", "(*)", "`-'"],
      ] as const;
      const pattern = patterns[Math.min(patterns.length - 1, Math.floor(shape * patterns.length))]!;
      const patternCenter = Math.floor(pattern[0]!.length / 2);
      for (let patternRow = 0; patternRow < pattern.length; patternRow += 1) {
        for (let patternColumn = 0; patternColumn < pattern[patternRow]!.length; patternColumn += 1) {
          const glyph = pattern[patternRow]![patternColumn]!;
          if (glyph !== " ") putBloom(tip.row - 1 + patternRow, tip.column - patternCenter + patternColumn, glyph, tone);
        }
      }
      put(middle.row, middle.column - 1, "/");
      if (shape > .25) put(middle.row, middle.column + 1, "\\");
    } else if (kind === "bud") {
      const tone = (Math.abs(seed) + bloomOrdinal * 3) % 4;
      bloomOrdinal += 1;
      const bud = shape < .5 ? [".-.", "(_)"] : ["(_)", "\\_/"];
      for (let budRow = 0; budRow < bud.length; budRow += 1) for (let budColumn = 0; budColumn < 3; budColumn += 1) {
        const glyph = bud[budRow]![budColumn]!;
        if (glyph !== " ") putBloom(tip.row - 1 + budRow, tip.column - 1 + budColumn, glyph, tone);
      }
      put(middle.row, middle.column + (shape < .5 ? -1 : 1), shape < .5 ? "/" : "\\");
    } else if (kind === "seed") {
      put(tip.row, tip.column, ":");
      put(tip.row, tip.column - 1, ".");
      put(tip.row, tip.column + 1, ".");
      if (positions.length > 2) {
        const crown = positions.at(-2)!;
        put(crown.row, crown.column - 1, "\\");
        put(crown.row, crown.column + 1, "/");
      }
    } else if (kind === "weed") {
      put(tip.row, tip.column, "'");
      put(tip.row, tip.column - 1, "\\");
      put(tip.row, tip.column + 1, "/");
      put(middle.row, middle.column - 1, "/");
      if (shape > .4) put(middle.row, middle.column + 1, "\\");
    } else {
      put(tip.row, tip.column, "'");
      put(tip.row, tip.column - 1, "o");
      put(tip.row, tip.column + 1, "o");
    }
  }

  const serialize = (rows: string[][]) => rows.map((row) => row.join("")).join("\n");
  return {
    field: serialize(field),
    blooms: bloomFields.map(serialize) as [string, string, string, string],
  };
}

export function renderAsciiGarden(options: AsciiGardenOptions): string {
  return renderAsciiGardenScene(options).field;
}

export function AsciiGarden() {
  const rootRef = useRef<HTMLDivElement>(null);
  const farRef = useRef<HTMLPreElement>(null);
  const nearRef = useRef<HTMLPreElement>(null);
  const roseBloomRef = useRef<HTMLPreElement>(null);
  const goldBloomRef = useRef<HTMLPreElement>(null);
  const violetBloomRef = useRef<HTMLPreElement>(null);
  const blueBloomRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const far = farRef.current;
    const near = nearRef.current;
    const roseBloom = roseBloomRef.current;
    const goldBloom = goldBloomRef.current;
    const violetBloom = violetBloomRef.current;
    const blueBloom = blueBloomRef.current;
    if (!root || !far || !near || !roseBloom || !goldBloom || !violetBloom || !blueBloom) return;
    const bloomLayers = [roseBloom, goldBloom, violetBloom, blueBloom] as const;
    const pageSeed = createPageSeed();
    const farSeed = (pageSeed ^ 0x5f356495) >>> 0;
    const nearSeed = (pageSeed ^ 0x27d4eb2d) >>> 0;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(pointer: fine)");
    const saveData = Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);
    let dimensions = { columns: MIN_COLUMNS, rows: MIN_ROWS };
    const metricCanvas = document.createElement("canvas");
    const metricContext = metricCanvas.getContext("2d");
    let pointer: GardenPointer | undefined;
    let pointerAt = 0;
    let animationFrame = 0;
    let lastDraw = -Infinity;

    const measure = () => {
      const bounds = root.getBoundingClientRect();
      const style = getComputedStyle(near);
      const fontSize = Number.parseFloat(style.fontSize) || 10;
      const lineHeight = Number.parseFloat(style.lineHeight) || fontSize;
      if (metricContext) metricContext.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const characterWidth = metricContext?.measureText("M").width || fontSize * .62;
      const columns = clamp(Math.floor(bounds.width / characterWidth), MIN_COLUMNS, MAX_COLUMNS);
      const letterSpacing = columns > 1 ? Math.max(0, (bounds.width - characterWidth * columns) / columns) : 0;
      for (const layer of [far, near, ...bloomLayers]) layer.style.letterSpacing = `${letterSpacing}px`;
      dimensions = {
        columns,
        rows: clamp(Math.floor(bounds.height / lineHeight), MIN_ROWS, MAX_ROWS),
      };
    };

    const draw = (now: number, still = false) => {
      const fade = pointer ? clamp(1 - (now - pointerAt) / 680, 0, 1) : 0;
      const activePointer = pointer && fade > 0 ? { ...pointer, strength: pointer.strength * fade } : undefined;
      const timeMs = still ? 0 : now;
      far.textContent = renderAsciiGarden({ ...dimensions, timeMs, seed: farSeed, depth: .45, ...(activePointer ? { pointer: { ...activePointer, strength: activePointer.strength * .45 } } : {}) });
      const nearScene = renderAsciiGardenScene({ ...dimensions, timeMs, seed: nearSeed, depth: 1, ...(activePointer ? { pointer: activePointer } : {}) });
      near.textContent = nearScene.field;
      for (let tone = 0; tone < bloomLayers.length; tone += 1) bloomLayers[tone]!.textContent = nearScene.blooms[tone]!;
    };

    const reduced = () => motion.matches || saveData;
    const tick = (now: number) => {
      if (now - lastDraw >= 66) {
        draw(now);
        lastDraw = now;
      }
      animationFrame = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(animationFrame);
      if (reduced() || document.hidden) {
        draw(0, true);
        return;
      }
      animationFrame = requestAnimationFrame(tick);
    };
    const resize = () => { measure(); draw(performance.now(), reduced()); };
    const move = (event: PointerEvent) => {
      if (reduced() || !finePointer.matches || (event.pointerType && event.pointerType !== "mouse" && event.pointerType !== "pen")) return;
      const bounds = root.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      pointer = {
        column: ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * (dimensions.columns - 1),
        row: ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * (dimensions.rows - 1),
        strength: 1,
      };
      pointerAt = performance.now();
    };
    const visibility = () => start();
    const motionChange = () => start();
    const observer = new ResizeObserver(resize);

    measure();
    draw(0, reduced());
    observer.observe(root);
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", motionChange);
    start();

    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener("pointermove", move);
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", motionChange);
    };
  }, []);

  return <div ref={rootRef} className="signin-garden" aria-hidden="true">
    <pre ref={farRef} className="signin-garden__layer signin-garden__layer--far" />
    <pre ref={nearRef} className="signin-garden__layer signin-garden__layer--near" />
    <pre ref={roseBloomRef} className="signin-garden__layer signin-garden__layer--bloom signin-garden__layer--rose" />
    <pre ref={goldBloomRef} className="signin-garden__layer signin-garden__layer--bloom signin-garden__layer--gold" />
    <pre ref={violetBloomRef} className="signin-garden__layer signin-garden__layer--bloom signin-garden__layer--violet" />
    <pre ref={blueBloomRef} className="signin-garden__layer signin-garden__layer--bloom signin-garden__layer--blue" />
  </div>;
}
