import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const tokenPath = path.join(root, "app/tokens.css");
const tokens = await readFile(tokenPath, "utf8");
const defined = new Set(
  [...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]),
);
const failures = [];
let count = 0;

function fail(file, source, offset, message) {
  const line = source.slice(0, offset).split("\n").length;
  failures.push(`${path.relative(root, file)}:${line}: ${message}`);
}

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(css|tsx|jsx)$/.test(entry.name) && file !== tokenPath)
      await check(file);
  }
}

async function check(file) {
  count++;
  const original = await readFile(file, "utf8");
  // Preserve offsets so diagnostics always point to the original line.
  const source = original.replace(/\/\*[\s\S]*?\*\//g, (value) =>
    value.replace(/[^\n]/g, " "),
  );
  for (const match of source.matchAll(/\bstyle\s*=\s*(?:\{|[\x22\x27])/g)) {
    fail(
      file,
      source,
      match.index,
      "Inline styles are forbidden. Use a class backed by semantic tokens.",
    );
  }
  for (const match of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (!defined.has(match[1]))
      fail(file, source, match.index, `Undefined token ${match[1]}.`);
    if (match[1].startsWith("--palette-"))
      fail(
        file,
        source,
        match.index,
        "Use semantic color tokens, not palette primitives.",
      );
  }
  if (!file.endsWith(".css")) return;
  // CSS media queries cannot consume custom properties. Only agreed breakpoints are exempt.
  const css = source.replace(/@media[^{}]+/g, (value) =>
    value.replace(/\b(?:375|768|1440)px\b/g, (match) =>
      " ".repeat(match.length),
    ),
  );
  for (const match of css.matchAll(
    /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch|color|device-cmyk|color-mix)\s*\(/gi,
  )) {
    fail(
      file,
      source,
      match.index,
      "Raw color: define a semantic token in app/tokens.css.",
    );
  }
  for (const match of css.matchAll(
    /(?<![\w-])-?(?:\d*\.)?\d+(?:px|rem|em|ch|ex|cap|ic|lh|rlh|cm|mm|Q|in|pt|pc|ms|s|deg|grad|rad|turn)\b/g,
  )) {
    fail(
      file,
      source,
      match.index,
      "Raw visual dimension: use a sizing, spacing, type, or motion token.",
    );
  }
  for (const match of css.matchAll(/(--[\w-]+)\s*:/g)) {
    fail(
      file,
      source,
      match.index,
      "Define all custom properties centrally in app/tokens.css.",
    );
  }
  const rules = /(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;}]+)/gm;
  for (const match of css.matchAll(rules)) {
    const [, property, value] = match;
    // Strip token references before inspecting the rest, so `var(--color-text) red`
    // and fallback literals cannot bypass validation just by containing `var(`.
    const namedColors =
      /\b(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgr[ae]y|darkgreen|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategr[ae]y|darkturquoise|darkviolet|deeppink|deepskyblue|dimgr[ae]y|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gr[ae]y|green|greenyellow|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgr[ae]y|lightgreen|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategr[ae]y|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategr[ae]y|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen|transparent)\b/i;
    const withoutTokens = value.replace(/var\(\s*--[\w-]+\s*\)/g, "");
    const paintProperty =
      /^(?:background(?:-image|-color)?|border(?:-(?:top|bottom|left|right))?(?:-color)?|outline(?:-color)?|color|fill|stroke|box-shadow|text-shadow|text-decoration(?:-color)?|accent-color|caret-color)$/;
    if (
      paintProperty.test(property) &&
      namedColors.test(withoutTokens.replace(/url\([^)]*\)/g, ""))
    ) {
      fail(
        file,
        source,
        match.index,
        `${property} contains a raw named color. Use a semantic token.`,
      );
    }
    const inherited = /^(?:inherit|initial|unset|revert|normal|none|0|1)$/;
    if (
      property === "font" &&
      !inherited.test(value.trim()) &&
      !/^var\(\s*--[\w-]+\s*\)$/.test(value.trim())
    ) {
      fail(
        file,
        source,
        match.index,
        "Font shorthand must be an inherited reset or a single font token.",
      );
    }
    if (
      /^(?:font-family|font-size|font-weight|line-height|letter-spacing|opacity|z-index|box-shadow|text-shadow)$/.test(
        property,
      ) &&
      !value.includes("var(") &&
      !inherited.test(value.trim())
    ) {
      fail(
        file,
        source,
        match.index,
        `${property} must use a token or an explicit structural reset.`,
      );
    }
    if (
      /^(?:color|background-color|border(?:-(?:top|bottom|left|right))?-color|outline-color|fill|stroke)$/.test(
        property,
      ) &&
      !value.includes("var(") &&
      !/^(?:inherit|none|currentColor)$/i.test(value.trim())
    ) {
      fail(
        file,
        source,
        match.index,
        `${property} must use a semantic color token.`,
      );
    }
  }
}

await walk(path.join(root, "app"));
await walk(path.join(root, "components"));
await walk(path.join(root, "desktop/src"));
if (failures.length) {
  console.error(
    `Token contract failed (${failures.length}):\n${failures.join("\n")}`,
  );
  process.exitCode = 1;
} else
  console.log(
    `Token contract passed: ${count} files checked; ${defined.size} centralized tokens.`,
  );
