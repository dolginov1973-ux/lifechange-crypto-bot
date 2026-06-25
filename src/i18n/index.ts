// Minimal bundled i18n. t(lang, key, vars?) with {var} interpolation and en fallback.
// Feature modules and translators reference ONLY keys that exist in en.json.

import { type Lang, asLang } from '../config';

import en from './en.json';
// Additional locales are added by translators as ./<lang>.json and registered below.
// They may be partial — any missing key falls back to en. Keep these imports static
// (Workers bundles them at build time; no dynamic import / fs at runtime).
// import hi from './hi.json';
// import pt from './pt.json';
// import vi from './vi.json';
// import es from './es.json';
// import tr from './tr.json';
// import id from './id.json';

/** A flat record of message keys -> template strings. */
export type Locale = Record<string, string>;

/** Registry of available locales. en is the master/fallback and is always complete. */
const LOCALES: Partial<Record<Lang, Locale>> = {
  en: en as Locale,
  // hi: hi as Locale,
  // pt: pt as Locale,
  // vi: vi as Locale,
  // es: es as Locale,
  // tr: tr as Locale,
  // id: id as Locale,
};

/** The full set of keys (derived from the master en locale). */
export type MsgKey = keyof typeof en;

/**
 * Translate `key` for `lang`, interpolating {var} placeholders from `vars`.
 * Falls back: requested lang -> en -> the raw key (so a missing key is visible, not blank).
 */
export function t(
  lang: string,
  key: MsgKey | string,
  vars?: Record<string, string | number>,
): string {
  const l = asLang(lang);
  const template =
    LOCALES[l]?.[key as string] ?? (en as Locale)[key as string] ?? String(key);
  return interpolate(template, vars);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** Convenience: the localized one-line risk disclaimer. */
export function disclaimer(lang: string): string {
  return t(lang, 'disclaimer');
}
