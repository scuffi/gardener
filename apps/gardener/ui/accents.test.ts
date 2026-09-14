import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Contrast guard for the brand accent layer.
 *
 * `accents.css` is the only file allowed to define brand colour values, so it is the only place
 * an accessibility regression can enter through colour. This test parses the real stylesheet
 * rather than a copy of its values, so editing the CSS without re-checking contrast fails here.
 */

// design-system-exempt: these are Kumo's canvas values, restated as test fixtures so contrast can
// be computed numerically. They are assertions about Kumo, not product styling.
const CANVAS_LIGHT = "#fcfcfc";
const CANVAS_DARK = "#0f0f0f";

/** WCAG 2.1 minimums. */
const TEXT_MINIMUM = 4.5;
const UI_MINIMUM = 3;

type Rgb = [number, number, number];

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255) as Rgb;
}

function oklchToRgb(lightness: number, chroma: number, hueDegrees: number): Rgb {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(linearToSrgb) as Rgb;
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => srgbToLinear(Math.min(1, Math.max(0, channel))));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((high as number) + 0.05) / ((low as number) + 0.05);
}

// Comments describe these very selectors, so strip them before parsing or the first "match"
// lands inside the documentation block.
const stylesheet = readFileSync(new URL("./accents.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Rule blocks, excluding anything nested in an at-rule such as the forced-colors override. */
const rules = [...stylesheet.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
  .map(([, selector, body]) => ({ selector: selector ?? "", body: body ?? "" }))
  .filter((rule) => !rule.selector.includes("@media"));

/**
 * Reads one accent token out of the stylesheet. Values are authored as
 * `light-dark(oklch(...), oklch(...))`, so both schemes come from a single declaration.
 */
function token(selector: string, property: string): { light: Rgb; dark: Rgb } {
  const rule = rules.find((candidate) => candidate.selector.includes(selector));
  expect(rule, `selector ${selector} not found`).toBeTruthy();
  const declaration = rule?.body.match(new RegExp(`${property}:\\s*([^;]+);`))?.[1];
  expect(declaration, `${property} not found in ${selector}`).toBeTruthy();
  const pairs = [...(declaration ?? "").matchAll(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)];
  expect(pairs.length, `${property} must use light-dark() with two oklch values`).toBe(2);
  const [light, dark] = pairs.map((match) =>
    oklchToRgb(Number(match[1]), Number(match[2]), Number(match[3])),
  );
  return { light: light as Rgb, dark: dark as Rgb };
}

const canvases = { light: hexToRgb(CANVAS_LIGHT), dark: hexToRgb(CANVAS_DARK) };
const WHITE: Rgb = [1, 1, 1];

describe("brand accents", () => {
  for (const accent of ["orange", "green"] as const) {
    const selector = `[data-accent="${accent}"]`;

    it(`${accent}: text token is readable on the canvas in both schemes`, () => {
      const text = token(selector, "--text-color-kumo-brand");
      expect(contrast(text.light, canvases.light)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
      expect(contrast(text.dark, canvases.dark)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
    });

    it(`${accent}: fill token carries Kumo's white button label in both schemes`, () => {
      const fill = token(selector, "--color-kumo-brand");
      expect(contrast(fill.light, WHITE)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
      expect(contrast(fill.dark, WHITE)).toBeGreaterThanOrEqual(TEXT_MINIMUM);
    });
  }

  for (const accent of ["orange", "green"] as const) {
    it(`${accent}: fill clears the UI boundary threshold in both schemes`, () => {
      const fill = token(`[data-accent="${accent}"]`, "--color-kumo-brand");
      expect(contrast(fill.light, canvases.light)).toBeGreaterThanOrEqual(UI_MINIMUM);
      expect(contrast(fill.dark, canvases.dark)).toBeGreaterThanOrEqual(UI_MINIMUM);
    });
  }
});
