/**
 * Terminal environment normalization utilities.
 *
 * Ensures UTF-8 locale and sane terminal defaults suitable for
 * Bun `env` fields and shell launcher exports.
 */

const UTF8_RE = /utf-?8/i;

function isUtf8(value: string): boolean {
  return UTF8_RE.test(value);
}

const DEFAULT_LOCALE = "en_US.UTF-8";
const DEFAULT_TERM = "xterm-256color";
const DEFAULT_COLORTERM = "truecolor";

const LOCALE_KEYS = ["LANG", "LC_ALL", "LC_CTYPE"] as const;

/**
 * Build a string-only environment record with normalized UTF-8 locale
 * and sane terminal defaults, derived from `baseEnv`.
 *
 * - `LANG`, `LC_ALL`, `LC_CTYPE`: preserved when already UTF-8; otherwise
 *   replaced with `en_US.UTF-8`.
 * - `TERM`: preserved when set and not `dumb`; defaults to `xterm-256color`.
 * - `COLORTERM`: preserved when set; defaults to `truecolor`.
 * - All other keys from `baseEnv` are carried through unchanged (string
 *   values only — `undefined` entries are dropped).
 */
export function normalizedTerminalEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  for (const key of LOCALE_KEYS) {
    const existing = result[key];
    if (!existing || !isUtf8(existing)) {
      result[key] = DEFAULT_LOCALE;
    }
  }

  const term = result["TERM"];
  if (!term || term === "dumb") {
    result["TERM"] = DEFAULT_TERM;
  }

  if (!result["COLORTERM"]) {
    result["COLORTERM"] = DEFAULT_COLORTERM;
  }

  return result;
}

/**
 * Merge explicit `envVars` on top of {@link normalizedTerminalEnv} defaults.
 *
 * Explicit keys in `envVars` always win. Missing terminal env keys still
 * receive sane defaults from `normalizedTerminalEnv`.
 *
 * @param envVars - Caller-supplied overrides (explicit values win).
 * @param baseEnv - Source environment; defaults to `process.env`.
 */
export function mergeTerminalEnv(
  envVars: Record<string, string> = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const defaults = normalizedTerminalEnv(baseEnv);
  return { ...defaults, ...envVars };
}
