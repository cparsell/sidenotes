/**
 * Source-text patterns for HTML sidenote spans.
 *
 * Factories rather than constants: these carry the `g` flag, so a shared
 * instance would leak `lastIndex` between callers.
 */

// Class-attribute fragment matching any span whose class list contains
// "sidenote" as a whole token — so it also covers the extra classes the
// per-note margin override adds (`sidenote right`, `sidenote margin-note
// left`). Requiring a full token keeps it from matching our own generated
// `sidenote-number` wrappers.
export const SIDENOTE_CLASS_ATTR = `class\\s*=\\s*["'](?:[^"']*\\s)?sidenote(?:\\s[^"']*)?["']`;

// Regex to detect sidenote spans in source text (includes margin-note variant)
export const SIDENOTE_PATTERN = () =>
	new RegExp(`<span\\s+${SIDENOTE_CLASS_ATTR}[^>]*>`, "gi");

export const SIDENOTE_SPAN_REGEX = () =>
	new RegExp(
		`<span\\s+${SIDENOTE_CLASS_ATTR}[^>]*>([\\s\\S]*?)<\\/span>`,
		"gi",
	);

// Same as SIDENOTE_PATTERN but captures the class list, so callers can read
// the per-note side override (`right` / `left`) out of the source text.
export const SIDENOTE_CLASS_CAPTURE_REGEX = () =>
	/<span\s+class\s*=\s*["']((?:[^"']*\s)?sidenote(?:\s[^"']*)?)["'][^>]*>/gi;
