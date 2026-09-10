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
  const density = .58 + depth * .24;
  const tallest = Math.max(2, Math.min(6, Math.floor(height * (.13 + depth * .12))));

  for (let column = 0; column < width; column += 1) {
    const presence = unit(seed, column, 3);
    if (presence > density) continue;
    const bladeHeight = 1 + Math.floor(unit(seed, column, 11) * tallest);
    const ambient = Math.sin(elapsed * .68 + column * .145 + seed) * .46
      + Math.sin(elapsed * .27 + column * .051 + seed * .37) * .2;
    let disturbance = 0;
    if (pointer?.strength) {
      const tipRow = height - bladeHeight;
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
    const lean = clamp((ambient + disturbance) * (.55 + depth * .18), -1.2, 1.2);

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
      far.style.letterSpacing = `${letterSpacing}px`;
      near.style.letterSpacing = `${letterSpacing}px`;
      dimensions = {
        columns,
        rows: clamp(Math.floor(bounds.height / lineHeight), MIN_ROWS, MAX_ROWS),
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
