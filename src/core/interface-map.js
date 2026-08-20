/**
 * Interface / surface classification.
 *
 * Rule: an interface is only ever derived from an explicit surface signal in
 * the source record (entrypoint, originator, source, IDE marker). It is NEVER
 * inferred from the model or the provider — "it's a Claude model so it must be
 * Claude Desktop" is exactly the mistake this module exists to prevent.
 * No signal => INTERFACE.UNKNOWN.
 */
import { INTERFACE } from './schema.js';

/** Ordered signal table. First match wins; the value is checked lowercased. */
/** @type {[RegExp, string][]} */
const SIGNALS = [
  // --- explicit IDE / editor hosts -------------------------------------
  [/^(vscode|vs-code|visual-?studio(-code)?|code-insiders)$/, INTERFACE.IDE],
  [/(^|[-_])(jetbrains|intellij|pycharm|webstorm|goland|rider|android-?studio)/, INTERFACE.IDE],
  [/^(cursor|windsurf|zed|neovim|nvim|vim|emacs|sublime)$/, INTERFACE.IDE],
  [/(^|[-_])ide($|[-_])/, INTERFACE.IDE],
  [/(^|[-_])(extension|plugin)($|[-_])/, INTERFACE.EXTENSION],

  // --- desktop apps ----------------------------------------------------
  [/desktop/, INTERFACE.DESKTOP],
  [/(^|[-_])(app|electron|tauri)$/, INTERFACE.DESKTOP],

  // --- web -------------------------------------------------------------
  [/(^|[-_])(web|browser|chatgpt-web|claude-ai)($|[-_])/, INTERFACE.WEB],

  // --- SDK / programmatic ---------------------------------------------
  [/sdk/, INTERFACE.SDK],
  [/(^|[-_])(api|rest|http|openai-python|anthropic-python)($|[-_])/, INTERFACE.API],

  // --- CLI / headless --------------------------------------------------
  [/(^|[-_ ])(cli|tui|exec|terminal|shell|headless|repl)($|[-_ ])/, INTERFACE.CLI],
  [/^(cli|tui|exec)$/, INTERFACE.CLI],
  // Named coding agents that only exist as terminal programs. This is still
  // evidence from a surface field (the originator/client name), not an
  // inference from the model.
  [/(^|[-_ ])(claude[-_ ]?code|aider|cline|opencode|crush|goose|amp|codebuff)($|[-_ ])/, INTERFACE.CLI],
];

/**
 * @param {(string|null|undefined)[]} signals ordered strongest-first
 * @returns {{interface: string, signal: string|null}}
 */
export function classifyInterface(signals) {
  for (const raw of signals) {
    if (!raw) continue;
    const s = String(raw).toLowerCase();
    for (const [re, iface] of SIGNALS) {
      if (re.test(s)) return { interface: iface, signal: String(raw) };
    }
  }
  return { interface: INTERFACE.UNKNOWN, signal: signals.find(Boolean) ?? null };
}
