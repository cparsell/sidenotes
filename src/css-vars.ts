/**
 * The plugin's entire visual configuration is expressed as `--sn-*` CSS custom
 * properties and `data-sn*` attributes on `<html>`, which `styles.css` then
 * consumes. This module is the single place they are written and cleared —
 * a total function of the settings, with no plugin state involved.
 *
 * `applyCssVariables` and `clearCssVariables` are inverses: every property or
 * attribute set by the former must be removed by the latter, or a disabled
 * plugin leaves styling behind.
 */

import type { SidenoteSettings } from "./settings";

/** The `data-sn*` attributes written by `applyCssVariables`. */
const DATA_ATTRIBUTES = [
	"snBadgeStyle",
	"snShowNumbers",
	"snFormat",
	"snHideFootnotes",
	"snHideFootnoteNumbers",
] as const;

/**
 * Write all `--sn-*` custom properties and `data-sn*` attributes onto `root`.
 */
export function applyCssVariables(
	settings: SidenoteSettings,
	root: HTMLElement = document.documentElement,
) {
	const s = settings;

	// Layout variables
	root.style.setProperty("--sn-base-width", `${s.minSidenoteWidth}rem`);
	root.style.setProperty(
		"--sn-max-extra",
		`${s.maxSidenoteWidth - s.minSidenoteWidth}rem`,
	);
	root.style.setProperty("--sn-gap", `${s.sidenoteGap}rem`);
	root.style.setProperty("--sn-gap2", `${s.sidenoteGap2}rem`);
	root.style.setProperty("--sn-page-offset-factor", `${s.pageOffsetFactor}`);

	// Compact mode
	root.style.setProperty(
		"--sn-base-width-compact",
		`${Math.max(s.minSidenoteWidth - 2, 6)}rem`,
	);
	root.style.setProperty(
		"--sn-max-extra-compact",
		`${Math.max((s.maxSidenoteWidth - s.minSidenoteWidth) / 2, 2)}rem`,
	);
	root.style.setProperty(
		"--sn-gap-compact",
		`${Math.max(s.sidenoteGap - 1, 0.5)}rem`,
	);
	root.style.setProperty(
		"--sn-gap2-compact",
		`${Math.max(s.sidenoteGap2 - 0.5, 0.25)}rem`,
	);

	// Full mode
	root.style.setProperty("--sn-base-width-full", `${s.maxSidenoteWidth}rem`);
	root.style.setProperty("--sn-gap-full", `${s.sidenoteGap + 1}rem`);
	root.style.setProperty("--sn-gap2-full", `${s.sidenoteGap2 + 0.5}rem`);

	// Typography.
	//
	// Resolve the size against Obsidian's base text size rather than
	// emitting a bare percentage. A percentage font-size resolves against
	// the *parent's* font size, so a sidenote anchored in an <h1> rendered
	// at 80% of the heading — much larger than one in body text. The var()
	// is substituted at the point of use, so it picks up --font-text-size
	// from the note's own cascade (themes and the Appearance setting still
	// apply); the px fallback only matters if that variable is missing.
	const baseFontSize = "var(--font-text-size, 16px)";
	root.style.setProperty(
		"--sn-font-size",
		`calc(${baseFontSize} * ${s.fontSize / 100})`,
	);
	root.style.setProperty(
		"--sn-font-size-compact",
		`calc(${baseFontSize} * ${s.fontSizeCompact / 100})`,
	);

	// Text Color
	root.style.setProperty(
		"--sn-text-color",
		s.textColor || "var(--text-normal)",
	);

	// Text color on hover
	if (s.hoverColor) {
		root.style.setProperty("--sn-hover-color", s.hoverColor);
	} else {
		root.style.removeProperty("--sn-hover-color");
	}

	// Line Height
	root.style.setProperty("--sn-line-height", `${s.lineHeight}`);
	root.style.setProperty(
		"--sn-line-height-compact",
		`${Math.max(s.lineHeight - 0.1, 1.1)}`,
	);

	// Text alignment
	const defaultAlignment = s.sidenotePosition === "left" ? "right" : "left";
	// Mirrored alignment for sidenotes overridden onto the opposite margin —
	// same explicit choice (justify/left/right) if the user set one, else
	// the alignment that faces the body text from the *other* side.
	const oppositeAlignment = s.sidenotePosition === "left" ? "left" : "right";
	const resolveAlignment = (auto: string) =>
		s.textAlignment === "justify"
			? "justify"
			: s.textAlignment === "left" || s.textAlignment === "right"
				? s.textAlignment
				: auto;
	const textAlign = resolveAlignment(defaultAlignment);
	root.style.setProperty("--sn-text-align", textAlign);
	root.style.setProperty(
		"--sn-text-align-opposite",
		resolveAlignment(oppositeAlignment),
	);

	// Number color
	if (s.numberColor) {
		root.style.setProperty("--sn-number-color", s.numberColor);
	} else {
		root.style.removeProperty("--sn-number-color");
	}

	// Transitions
	root.style.setProperty(
		"--sn-transition",
		s.enableTransitions
			? "width 0.15s ease-out, left 0.15s ease-out, right 0.15s ease-out, opacity 0.15s ease-out"
			: "none",
	);

	// Data attributes for CSS selectors
	root.dataset.snBadgeStyle = s.numberBadgeStyle;
	root.dataset.snShowNumbers = s.showSidenoteNumbers ? "true" : "false";
	root.dataset.snFormat = s.sidenoteFormat;
	root.dataset.snHideFootnotes = s.hideFootnotes ? "true" : "false";
	root.dataset.snHideFootnoteNumbers = s.hideFootnoteNumbers ? "true" : "false";

	// Margin note specific styles
	root.style.setProperty("--sn-mn-popup-scale", `${s.popupIconScaleFactor}em`);
	root.style.setProperty(
		"--sn-mn-marker-scale",
		`${s.marginNoteScaleFactor}em`,
	);
}

/**
 * Remove everything `applyCssVariables` wrote. Inverse of the above.
 */
export function clearCssVariables(
	root: HTMLElement = document.documentElement,
) {
	const propsToRemove = Array.from(root.style).filter((p) =>
		p.startsWith("--sn-"),
	);
	for (const prop of propsToRemove) {
		root.style.removeProperty(prop);
	}

	for (const attr of DATA_ATTRIBUTES) {
		delete root.dataset[attr];
	}
}
