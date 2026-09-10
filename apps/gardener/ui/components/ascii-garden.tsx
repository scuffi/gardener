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

export function renderAsciiGarden({ columns, rows, timeMs, seed, depth = 1, pointer }: AsciiGardenOptions): string {
  const width = clamp(Math.floor(columns), MIN_COLUMNS, MAX_COLUMNS);
  const height = clamp(Math.floor(rows), MIN_ROWS, MAX_ROWS);
  const field = Array.from({ length: height }, () => Array<string>(width).fill(" "));
  const elapsed = timeMs / 1_000;
  const density = .38 + depth * .27;
  const tallest = Math.max(2, Math.floor((height - 2) * (.24 + depth * .22)));

  for (let column = 0; column < width; column += 1) {
    const presence = unit(seed, column, 3);
    if (presence > density) continue;
    const bladeHeight = 1 + Math.floor(unit(seed, column, 11) * tallest);
    const ambient = Math.sin(elapsed * .72 + column * .145 + seed) * .56
      + Math.sin(elapsed * .29 + column * .051 + seed * .37) * .28;
    let disturbance = 0;
    if (pointer?.strength) {
      const tipRow = height - bladeHeight;
      const deltaColumn = column - pointer.column;
      const deltaRow = (tipRow - pointer.row) * 1.65;
      const radius = 10 + depth * 5;
      const distanceSquared = deltaColumn * deltaColumn + deltaRow * deltaRow;
      if (distanceSquared <= radius * radius * 2.25) {
        const influence = Math.exp(-distanceSquared / (radius * radius));
        const direction = deltaColumn === 0 ? (unit(seed, column, 29) > .5 ? 1 : -1) : Math.sign(deltaColumn);
        disturbance = direction * influence * pointer.strength * 1.55;
      }
    }
    const lean = clamp((ambient + disturbance) * (.62 + depth * .2), -1.35, 1.35);
    const stem = lean < -.32 ? "\\" : lean > .32 ? "/" : "|";

    for (let segment = 0; segment < bladeHeight; segment += 1) {
      const row = height - 2 - segment;
      const offset = Math.round(lean * segment * .28);
      const target = column + offset;
      if (row < 0 || target < 0 || target >= width) continue;
      const tip = segment === bladeHeight - 1;
      field[row]![target] = tip ? (lean < -.22 ? "\\" : lean > .22 ? "/" : "'") : stem;
    }

    const baseGlyph = presence < .16 ? "_" : presence < .34 ? "," : ".";
    field[height - 1]![column] = baseGlyph;
  }

  for (let column = 0; column < width; column += 1) {
    if (field[height - 1]![column] === " " && unit(seed, column, 41) < .3 + depth * .2) {
      field[height - 1]![column] = unit(seed, column, 43) > .5 ? "." : ",";
    }
  }

  return field.map((row) => row.join("")).join("\n");
}

export function AsciiGarden() {
  const rootRef = useRef<HTMLDivElement>(null);
  const farRef = useRef<HTMLPreElement>(null);
  const nearRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const far = farRef.current;
    const near = nearRef.current;
    if (!root || !far || !near) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(pointer: fine)");
    const saveData = Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);
    let dimensions = { columns: MIN_COLUMNS, rows: MIN_ROWS };
    let pointer: GardenPointer | undefined;
    let pointerAt = 0;
    let animationFrame = 0;
    let lastDraw = -Infinity;

    const measure = () => {
      const bounds = root.getBoundingClientRect();
      dimensions = {
        columns: clamp(Math.floor(bounds.width / (bounds.width < 520 ? 5.8 : 6.5)), MIN_COLUMNS, MAX_COLUMNS),
        rows: clamp(Math.floor(bounds.height / 11), MIN_ROWS, MAX_ROWS),
      };
    };

    const draw = (now: number, still = false) => {
      const fade = pointer ? clamp(1 - (now - pointerAt) / 680, 0, 1) : 0;
      const activePointer = pointer && fade > 0 ? { ...pointer, strength: pointer.strength * fade } : undefined;
      const timeMs = still ? 0 : now;
      far.textContent = renderAsciiGarden({ ...dimensions, timeMs, seed: 17, depth: .45, ...(activePointer ? { pointer: { ...activePointer, strength: activePointer.strength * .45 } } : {}) });
      near.textContent = renderAsciiGarden({ ...dimensions, timeMs, seed: 53, depth: 1, ...(activePointer ? { pointer: activePointer } : {}) });
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
  </div>;
}
