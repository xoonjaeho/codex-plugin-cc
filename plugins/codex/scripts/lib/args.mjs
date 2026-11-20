export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const rejectUnknownOptions = Boolean(config.rejectUnknownOptions);
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (rejectUnknownOptions) {
        throw new Error(`Unknown option: --${rawKey}`);
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    if (rejectUnknownOptions) {
      throw new Error(`Unknown option: -${shortKey}`);
    }

    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < raw.length; i++) {
    const character = raw[i];
    if (character === "\\") {
      // Backslash escapes only a quote or another backslash; any other
      // following character (e.g. a Windows path separator) stays literal,
      // so `C:\Users\...` survives while `\"` and `\\` still escape.
      const next = raw[i + 1];
      if (next === "\"" || next === "\\" || next === "'") {
        current += next;
        i += 1;
        continue;
      }
      current += character;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

// Slash commands pass "$ARGUMENTS" as one shell word; the background flows prepend
// --background as its own word, so that raw string still needs splitting.
// splitAfterBackground: only the review commands, whose docs pass `--background "$ARGUMENTS"`;
// a direct `task --background "<prompt>"` must keep its prompt as one argument.
export function normalizeArgv(argv, { splitAfterBackground = false } = {}) {
  if (argv.length === 1 || (splitAfterBackground && argv.length === 2 && argv[0] === "--background")) {
    const raw = argv[argv.length - 1];
    const flags = argv.slice(0, -1);
    if (!raw || !raw.trim()) {
      return flags;
    }
    return [...flags, ...splitRawArgumentString(raw)];
  }
  return argv;
}
