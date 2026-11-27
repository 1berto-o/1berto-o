#!/usr/bin/env node
/**
 * Post-process Platane/snk SVGs so contribution cells stay permanently visible.
 *
 * snk animates each "eaten" cell from its contribution color to the empty color.
 * That hides active days mid-animation. We keep the snake + stack animations,
 * but freeze the calendar fill so every contribution day remains readable.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const distDir = process.argv[2] || "dist";

/** Improved purple scales — distinguishable on dark and light empty dots. */
const PALETTES = {
  dark: {
    empty: "#0B0B0F",
    dots: ["#0B0B0F", "#5B21B6", "#7C3AED", "#A78BFA", "#EDE9FE"],
    snake: "#8B5CF6",
  },
  light: {
    empty: "#EBEDF0",
    dots: ["#EBEDF0", "#DDD6FE", "#A78BFA", "#7C3AED", "#5B21B6"],
    snake: "#7C3AED",
  },
};

const isDarkFile = (name) => /dark/i.test(name);

const applyRootVars = (svg, palette) => {
  const [c0, c1, c2, c3, c4] = palette.dots;
  return svg.replace(/:root\{[^}]*\}/, () => {
    return `:root{--cb:#1b1f230a;--cs:${palette.snake};--ce:${palette.empty};--c0:${c0};--c1:${c1};--c2:${c2};--c3:${c3};--c4:${c4}}`;
  });
};

/**
 * Freeze contribution calendar cells:
 * - keep static fill:var(--cN)
 * - disable the eat-to-empty animation on .c.c*
 * - drop @keyframes c* so nothing can hide them later
 * Snake (.s) and stack (.u) animations are untouched.
 */
const freezeContributionCells = (svg) => {
  let out = svg;

  // .c.c0{fill:var(--c1);animation-name:c0} -> permanent fill, no animation
  out = out.replace(
    /\.c\.(c[0-9a-f]+)\s*\{\s*fill:\s*(var\(--c[0-4]\))\s*;\s*animation-name:\s*c[0-9a-f]+\s*\}/g,
    ".c.$1{fill:$2;animation:none}",
  );

  // Remove contribution-cell keyframes (c0, c1, ...). Keep u* and s*.
  // snk emits compact keyframes: @keyframes c0{31%{fill:var(--c1)}32%,100%{fill:var(--ce)}}
  out = out.replace(/@keyframes c[0-9a-f]+\{(?:[^{}]|\{[^{}]*\})*\}/g, "");

  return out;
};

const assertFrozen = (svg, file) => {
  if (/@keyframes c[0-9a-f]+\{/.test(svg)) {
    throw new Error(`${file}: contribution keyframes still present`);
  }
  if (/animation-name:\s*c[0-9a-f]+/.test(svg)) {
    throw new Error(`${file}: contribution cells still reference eat animations`);
  }
  const permanent = (svg.match(/\.c\.c[0-9a-f]+\{fill:var\(--c[1-4]\);animation:none\}/g) || [])
    .length;
  if (permanent < 1) {
    throw new Error(`${file}: no permanently visible contribution cells found`);
  }
  return permanent;
};

const files = readdirSync(distDir).filter((f) => f.endsWith(".svg"));
if (files.length === 0) {
  console.error(`No SVG files in ${distDir}`);
  process.exit(1);
}

for (const file of files) {
  const path = join(distDir, file);
  let svg = readFileSync(path, "utf8");
  const palette = isDarkFile(file) ? PALETTES.dark : PALETTES.light;

  svg = applyRootVars(svg, palette);
  svg = freezeContributionCells(svg);
  const permanent = assertFrozen(svg, file);

  if (!svg.includes(palette.snake)) {
    throw new Error(`${file}: missing snake color ${palette.snake}`);
  }
  if (!svg.includes(palette.dots[1])) {
    throw new Error(`${file}: missing level-1 color ${palette.dots[1]}`);
  }
  // Ensure low-contrast legacy dark color is gone from dark SVG
  if (isDarkFile(file) && svg.includes("#2E1065")) {
    throw new Error(`${file}: legacy low-contrast #2E1065 still present`);
  }

  writeFileSync(path, svg, "utf8");
  console.log(
    JSON.stringify({
      file,
      permanentContributionCells: permanent,
      palette: isDarkFile(file) ? "dark-purple" : "light-purple",
      empty: palette.empty,
      dots: palette.dots,
      snake: palette.snake,
    }),
  );
}
