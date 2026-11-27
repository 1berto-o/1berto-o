#!/usr/bin/env node
/**
 * Dual-layer post-process for Platane/snk SVGs.
 *
 * Layer 1 — calendar-base (behind): static contribution cells, always visible.
 * Layer 2 — original snk animation (front): c* eat keyframes + s* snake + u* stack.
 *
 * Eat keyframes are kept, but the "eaten" fill becomes transparent so the base
 * layer shows through instead of being covered by an opaque empty color.
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

/** Base layer opacity: eaten cells dim but remain readable. */
const BASE_OPACITY = "0.55";

const isDarkFile = (name) => /dark/i.test(name);

const applyRootVars = (svg, palette) => {
  const [c0, c1, c2, c3, c4] = palette.dots;
  return svg.replace(
    /:root\{[^}]*\}/,
    `:root{--cb:#1b1f230a;--cs:${palette.snake};--ce:${palette.empty};--c0:${c0};--c1:${c1};--c2:${c2};--c3:${c3};--c4:${c4}}`,
  );
};

/**
 * Make eaten cells transparent (not opaque empty) so the static base shows through.
 * Preserves every @keyframes c* block and timing.
 */
const makeEatRevealBase = (svg) =>
  svg.replace(
    /(@keyframes c[0-9a-f]+\{(?:[^{}]|\{[^{}]*\})*\})/g,
    (block) => block.replace(/fill:var\(--ce\)/g, "fill:transparent"),
  );

/**
 * Build a static underlay of contribution cells (class cb*) + CSS.
 * Inserted immediately after </style>, behind the animated grid.
 */
const injectStaticBaseLayer = (svg) => {
  const contribRuleRe =
    /\.c\.(c[0-9a-f]+)\s*\{\s*fill:\s*(var\(--c[1-4]\))\s*;\s*animation-name:\s*(c[0-9a-f]+)\s*\}/g;

  const rules = [...svg.matchAll(contribRuleRe)];
  if (rules.length === 0) {
    throw new Error("No animated contribution cell rules (.c.c*) found");
  }

  // Map animated class id -> fill var, e.g. c0 -> var(--c1)
  const fillById = new Map(rules.map((m) => [m[1], m[2]]));

  const contribRectRe =
    /<rect class="c (c[0-9a-f]+)"([^>]*)\/>/g;
  const rects = [...svg.matchAll(contribRectRe)];
  if (rects.length === 0) {
    throw new Error("No contribution rects found");
  }

  const baseStyles = [
    `.cb{shape-rendering:geometricPrecision;stroke-width:1px;stroke:var(--cb);animation:none;width:12px;height:12px}`,
    ...[...fillById.entries()].map(
      ([id, fill]) => `.cb.${id}{fill:${fill}}`,
    ),
  ].join("");

  const baseRects = rects
    .map((m) => {
      const id = m[1];
      const attrs = m[2];
      if (!fillById.has(id)) {
        throw new Error(`Missing fill rule for contribution cell ${id}`);
      }
      return `<rect class="cb ${id}"${attrs}/>`;
    })
    .join("");

  const baseGroup = `<g id="calendar-base" opacity="${BASE_OPACITY}">${baseRects}</g>`;

  // Inject base CSS before </style>
  let out = svg.replace("</style>", `${baseStyles}</style>`);

  // Inject base group right after </style> (behind subsequent animated rects)
  out = out.replace("</style>", `</style>${baseGroup}`);

  return { svg: out, baseCount: rects.length, animatedRules: rules.length };
};

const assertDualLayer = (svg, file) => {
  if (!svg.includes('id="calendar-base"')) {
    throw new Error(`${file}: missing calendar-base layer`);
  }
  const cKeys = (svg.match(/@keyframes c[0-9a-f]+\{/g) || []).length;
  const sKeys = (svg.match(/@keyframes s[0-9a-f]+\{/g) || []).length;
  const uKeys = (svg.match(/@keyframes u[0-9a-f]+\{/g) || []).length;
  if (cKeys < 1) throw new Error(`${file}: contribution eat keyframes c* missing`);
  if (sKeys < 1) throw new Error(`${file}: snake keyframes s* missing`);
  if (uKeys < 1) throw new Error(`${file}: stack keyframes u* missing`);

  // Animated cells must still reference c* animations (not animation:none)
  const animated = (
    svg.match(
      /\.c\.c[0-9a-f]+\s*\{\s*fill:\s*var\(--c[1-4]\)\s*;\s*animation-name:\s*c[0-9a-f]+\s*\}/g,
    ) || []
  ).length;
  if (animated < 1) {
    throw new Error(`${file}: animated contribution cells lost animation-name`);
  }

  // Eaten state must reveal base (transparent), not paint opaque empty over it
  const cBlocks = svg.match(/@keyframes c[0-9a-f]+\{(?:[^{}]|\{[^{}]*\})*\}/g) || [];
  for (const block of cBlocks) {
    if (/fill:var\(--ce\)/.test(block)) {
      throw new Error(`${file}: eat keyframe still uses opaque --ce`);
    }
    if (!/fill:transparent/.test(block)) {
      throw new Error(`${file}: eat keyframe missing transparent reveal`);
    }
  }

  const baseCells = (svg.match(/<rect class="cb c[0-9a-f]+"/g) || []).length;
  if (baseCells !== animated) {
    throw new Error(
      `${file}: base/animated cell mismatch (${baseCells} vs ${animated})`,
    );
  }

  // Ensure base group appears before the first animated contribution rect
  const basePos = svg.indexOf('id="calendar-base"');
  const firstAnim = svg.search(/<rect class="c c[0-9a-f]+"/);
  if (basePos < 0 || firstAnim < 0 || basePos > firstAnim) {
    throw new Error(`${file}: calendar-base must be behind animated cells`);
  }

  return { baseCells, animated, cKeys, sKeys, uKeys };
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

  // Idempotent: strip a previous calendar-base if re-run
  svg = svg.replace(/<g id="calendar-base"[^>]*>[\s\S]*?<\/g>/, "");
  svg = svg.replace(/\.cb\{[^}]*\}/g, "");
  svg = svg.replace(/\.cb\.c[0-9a-f]+\{[^}]*\}/g, "");

  svg = applyRootVars(svg, palette);
  svg = makeEatRevealBase(svg);
  const injected = injectStaticBaseLayer(svg);
  svg = injected.svg;

  const stats = assertDualLayer(svg, file);

  if (!svg.includes(palette.snake)) {
    throw new Error(`${file}: missing snake color ${palette.snake}`);
  }
  if (!svg.includes(palette.dots[1])) {
    throw new Error(`${file}: missing level-1 color ${palette.dots[1]}`);
  }
  if (isDarkFile(file) && svg.includes("#2E1065")) {
    throw new Error(`${file}: legacy low-contrast #2E1065 still present`);
  }

  writeFileSync(path, svg, "utf8");
  console.log(
    JSON.stringify({
      file,
      ...stats,
      baseOpacity: BASE_OPACITY,
      palette: isDarkFile(file) ? "dark-purple" : "light-purple",
      empty: palette.empty,
      dots: palette.dots,
      snake: palette.snake,
    }),
  );
}
