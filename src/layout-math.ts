/**
 * Geometry for sidenote placement.
 *
 * Everything here is a pure function of the settings, the root element it is
 * handed, and (for the page offset) which margins the document actually
 * occupies. No plugin state, no timers, no observers — which is what makes the
 * positioning logic possible to reason about in isolation.
 */

import type { SidenoteSettings } from "./settings";
import type { SidenoteSide } from "./content";
import { setCssProps } from "./dom-utils";

/**
 * Offsets are rewritten on every positioning pass, and `--sn-transition`
 * animates left/right — so any sub-pixel difference between passes plays as a
 * visible slide. The inputs jitter easily: the probe measurement in
 * getSidenoteWidthPx, fractional element rects, a scrollbar appearing. Whole
 * pixels are below the precision anyone can see in a margin position, and
 * writing an identical string is what stops the transition from firing.
 */
function pxRounded(value: number): string {
	return `${Math.round(value)}px`;
}

export type SidenoteMode = "hidden" | "compact" | "normal" | "full";

/**
 * A visible top-level block whose left/right edges mark the body text column.
 *
 * Obsidian virtualises reading mode, so the first <p> may have zero size or be
 * nested inside a blockquote/list. Walk the sizer's direct child <div>s and
 * pick the first containing a visible block-level element at the top level of
 * the content flow, falling back to the sizer itself.
 *
 * Only `updateSidenotePositioning` uses this, and only as a last-resort
 * fallback for the text edge (it prefers `getReadingTextLeft`). Do not reach
 * for it as a measurement baseline — see the comment in
 * `correctIndentedSidenotePositions` for why that goes wrong.
 */
function findReadingRefElement(root: HTMLElement): HTMLElement | null {
	const sizer = root.querySelector<HTMLElement>(".markdown-preview-sizer");
	if (!sizer) return null;

	const sections = sizer.querySelectorAll<HTMLElement>(":scope > div");
	for (const section of Array.from(sections)) {
		if (section.offsetHeight === 0) continue;
		const candidate = section.querySelector<HTMLElement>(
			":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6",
		);
		if (candidate && candidate.offsetHeight > 0) {
			return candidate;
		}
	}

	return sizer;
}

/**
 * Write the width-derived layout attributes onto a reading or editing root,
 * and return the resolved mode.
 *
 * This block was written out verbatim in three places — reading-mode
 * processing, the reading-mode layout pass, and the editing-mode layout pass —
 * which is exactly the kind of drift that makes a settings change apply in one
 * mode but not the other.
 */
export function applyRootMetrics(
	settings: SidenoteSettings,
	root: HTMLElement,
	width: number,
): SidenoteMode {
	root.style.setProperty("--editor-width", `${width}px`);

	const mode = calculateMode(settings, width);
	root.dataset.sidenoteMode = mode;
	root.dataset.sidenotePosition = settings.sidenotePosition;
	root.dataset.sidenoteAnchor = settings.sidenoteAnchor;

	root.style.setProperty(
		"--sidenote-scale",
		calculateScaleFactor(settings, width).toFixed(3),
	);

	return mode;
}

/** Inverse of `applyRootMetrics`, plus the flags set elsewhere during layout. */
export function clearRootMetrics(root: HTMLElement) {
	root.style.removeProperty("--editor-width");
	root.style.removeProperty("--sidenote-scale");
	root.style.removeProperty("--sidenote-gap-effective");
	root.dataset.sidenoteMode = "";
	root.dataset.hasSidenotes = "";
	root.dataset.sidenotePosition = "";
	root.dataset.sidenoteHasOpposite = "";
}

/**
 * Calculate and apply sidenote positioning based on anchor mode and gaps.
 *
 * For LEFT sidenotes:
 * - TEXT ANCHOR: Sidenote's right edge is gap1 away from text. As editor widens,
 *   gap between sidenote and editor edge increases.
 * - EDGE ANCHOR: Sidenote's left edge is gap2 away from editor edge. As editor widens,
 *   gap between sidenote and text increases.
 *
 * Both modes respect both gap constraints as minimums.
 */
export function updateSidenotePositioning(
	settings: SidenoteSettings,
	sides: Record<SidenoteSide, boolean>,
	root: HTMLElement,
	isReadingMode: boolean,
) {
	const s = settings;
	const position = s.sidenotePosition;
	const anchorMode = s.sidenoteAnchor;

	// Whenever a per-sidenote override actually places a note on the
	// non-default margin, reserve page-offset space there too (see the
	// matching CSS rules gated on [data-sidenote-has-opposite]) — without
	// it, the override side has no room at all and edge-anchored notes
	// collapse against (or past) the pane's real edge instead of
	// respecting sidenoteGap/sidenoteGap2.
	//
	// This reads the source-derived map, NOT a DOM query: both CM6 and
	// reading mode virtualise, so querying mounted `.sidenote-margin`
	// elements returns null as soon as you scroll past the last override.
	// That toggled the mirrored padding off mid-scroll and visibly shifted
	// the body text sideways.
	const oppositeSide: SidenoteSide =
		position === "left" ? "right" : "left";
	root.dataset.sidenoteHasOpposite = sides[
		oppositeSide
	]
		? "true"
		: "false";

	// Get root element rect
	const rootRect = root.getBoundingClientRect();

	// console.log("[Sidenotes] updateSidenotePositioning:", {
	// 	rootWidth: rootRect.width,
	// 	isReadingMode,
	// 	isConnected: root.isConnected,
	// });

	// Get rem to px conversion
	const remToPx =
		parseFloat(getComputedStyle(document.documentElement).fontSize) ||
		16;
	// Base gaps (minimums)
	const baseGap1 = s.sidenoteGap * remToPx; // gap between sidenote and text
	const baseGap2 = s.sidenoteGap2 * remToPx; // gap between sidenote and edge

	// Scale gaps proportionally as editor grows.
	// Use the sidenoteGapDrift setting to control growth rate.
	// At hideBelow width, gaps are at their minimum.
	// As width increases, gaps grow by a fraction of the extra available space.
	const editorWidth = rootRect.width;
	const growthFactor = s.sidenoteGapDrift; // 0 = no growth, 1 = maximum growth
	const extraSpace = Math.max(0, editorWidth - s.hideBelow);
	const gapGrowth = extraSpace * growthFactor * 0.25; // subtle growth

	const gap1 = baseGap1 + gapGrowth;
	const gap2 = baseGap2 + gapGrowth;

	// Publish the *grown* gap so the CSS that reserves margin space uses the
	// same number this function positions against.
	//
	// `--page-offset` used to be computed from the base `--sidenote-gap`, with
	// no knowledge of gapGrowth — so with sidenoteGapDrift above 0 it reserved
	// less room than the sidenote actually needs, and the shortfall widened
	// with the pane. In text-anchor mode that clipped the left edge of
	// left-margin sidenotes.
	//
	// Written before the reference-line lookup below, which can bail: the
	// reservation should stay correct even when positioning cannot run.
	root.style.setProperty("--sidenote-gap-effective", pxRounded(gap1));

	// Find a representative line/paragraph to measure the text column edge.
	// In reading mode, Obsidian virtualises content so the first <p> may
	// have zero size or be nested inside a blockquote/list.  Walk the
	// sizer's direct child <div>s and pick the first one that contains a
	// visible block-level element at the top level of the content flow.
	const refLine: HTMLElement | null = isReadingMode
		? findReadingRefElement(root)
		: findStableCmRefLine(root);

	if (!refLine) return;

	const refRect = refLine.getBoundingClientRect();

	// Get sidenote width from an existing margin element, or fall back to calculation
	const sidenoteWidth = getSidenoteWidthPx(settings, root);

	// Compute both sides unconditionally so a per-sidenote override can
	// place an individual note in the margin opposite the document-wide
	// "Sidenote position" setting.

	// --- LEFT ---
	// Available space between editor left edge and the text (refLine left edge)
	const textLeft = isReadingMode
		? (getReadingTextLeft(root) ?? refRect.left)
		: (getEditorTextEdges(root)?.left ?? refRect.left);

	// The real editor edge (scroller/view), not rootRect.left, which may
	// already carry the page-offset padding.
	const editorEdgeLeft = (() => {
		if (isReadingMode) return root.getBoundingClientRect().left;
		const scroller = root.querySelector<HTMLElement>(".cm-scroller");
		return (scroller ?? root).getBoundingClientRect().left;
	})();

	// The two candidate positions, both expressed relative to the text column
	// edge. Each anchor mode prefers one and is bounded by the other.
	//
	// Text-anchored: the note's RIGHT edge sits gap1 from the text.
	// Edge-anchored: the note's LEFT edge sits gap2 from the pane edge.
	const textAnchoredLeft = -(gap1 + sidenoteWidth);
	const edgeAnchoredLeft = editorEdgeLeft + gap2 - textLeft;

	let cssLeft: number;
	if (anchorMode === "text") {
		// The gap to the text is the whole point of this mode, so it is never
		// traded away. Clamping the note to the pane edge when space runs short
		// was tried and is worse: it slides the note over the body text, which
		// is less usable than a note that runs off the edge.
		cssLeft = textAnchoredLeft;
	} else {
		// Prefer the pane edge, but never intrude into the text column.
		cssLeft = Math.min(edgeAnchoredLeft, textAnchoredLeft);
	}

	// --- RIGHT ---
	// Available space between text (refLine right edge) and editor right edge
	const textEdges = !isReadingMode
		? getEditorTextEdges(root)
		: null;
	const textRight = textEdges ? textEdges.right : refRect.right;

	const editorEdgeRight = (() => {
		if (isReadingMode) return root.getBoundingClientRect().right;

		const scroller = root.querySelector<HTMLElement>(".cm-scroller");
		return (scroller ?? root).getBoundingClientRect().right;
	})();

	// Mirror of the left side. cssRight works inversely: more negative moves
	// the element further right.
	const textAnchoredRight = -(gap1 + sidenoteWidth);
	const edgeAnchoredRight = editorEdgeRight - gap2 - textRight;

	let cssRight: number;
	if (anchorMode === "text") {
		cssRight = textAnchoredRight;
	} else {
		cssRight = Math.min(edgeAnchoredRight, textAnchoredRight);
	}

	root.style.setProperty("--sidenote-offset-left", pxRounded(cssLeft));
	root.style.setProperty("--sidenote-offset-right", pxRounded(cssRight));
	root.style.setProperty(
		"--sidenote-offset",
		pxRounded(position === "left" ? cssLeft : cssRight),
	);
}


export function measureCssLengthPx(
	host: HTMLElement,
	cssLengthExpr: string,
): number {
	const probe = createDiv();
	probe.classList.add("sidenote-measure-probe");
	probe.style.width = cssLengthExpr;
	host.appendChild(probe);
	const w = probe.getBoundingClientRect().width;
	probe.remove();
	return w;
}


export function getSidenoteWidthPx(
	settings: SidenoteSettings,
	root: HTMLElement,
): number {
	// Root here should be the element that has --sidenote-width in scope
	const cs = getComputedStyle(root);
	const expr = cs.getPropertyValue("--sidenote-width").trim();
	if (expr) return measureCssLengthPx(root, expr);

	// fallback
	const remToPx =
		parseFloat(getComputedStyle(document.documentElement).fontSize) ||
		16;
	return settings.minSidenoteWidth * remToPx;
}


/**
 * The body text column edges in reading mode: the preview sizer's CONTENT
 * box, i.e. inside its page padding.
 *
 * This is the same column a top-level paragraph occupies, which is why it is
 * a valid stand-in for one. The sizer's *border* box is not — it sits outside
 * the padding, and using it as a baseline inflates every measurement by that
 * padding.
 */
export function getReadingTextEdges(
	root: HTMLElement,
): { left: number; right: number } | null {
	const sizer = root.querySelector<HTMLElement>(
		".markdown-preview-sizer",
	);
	if (!sizer) return null;
	const r = sizer.getBoundingClientRect();
	const cs = getComputedStyle(sizer);
	return {
		left: r.left + (parseFloat(cs.paddingLeft) || 0),
		right: r.right - (parseFloat(cs.paddingRight) || 0),
	};
}

export function getReadingTextLeft(root: HTMLElement): number | null {
	return getReadingTextEdges(root)?.left ?? null;
}


export function getEditorTextEdges(
	root: HTMLElement,
): { left: number; right: number } | null {
	// The page offset for sidenotes is applied to the scroller, so measure from it.
	const scroller = root.querySelector<HTMLElement>(".cm-scroller");
	if (!scroller) return null;

	const r = scroller.getBoundingClientRect();
	const cs = getComputedStyle(scroller);
	const pl = parseFloat(cs.paddingLeft) || 0;
	const pr = parseFloat(cs.paddingRight) || 0;

	return {
		left: r.left + pl,
		right: r.right - pr,
	};
}

/**
 * Helper for updateSidenotePositioning to find a stable reference line
 * This helps to establish reliable positioning even when the first lines are empty or virtualized.
 * @param root
 * @returns
 */

/**
 * Helper for updateSidenotePositioning to find a stable reference line
 * This helps to establish reliable positioning even when the first lines are empty or virtualized.
 * @param root
 * @returns
 */
export function findStableCmRefLine(root: HTMLElement): HTMLElement | null {
	const rootRect = root.getBoundingClientRect();
	const lines = Array.from(
		root.querySelectorAll<HTMLElement>(".cm-line"),
	);

	// Prefer a line that is:
	// - visible (height > 0)
	// - not collapsed to left edge (left significantly inside the root)
	// - has non-trivial width
	for (const el of lines) {
		if (!el.isConnected) continue;
		const r = el.getBoundingClientRect();
		if (r.height < 8) continue;
		if (r.width < 40) continue;

		const inset = r.left - rootRect.left;

		// Heuristic: text column is usually inset by padding/gutter; reject 0–2px.
		if (inset <= 2) continue;

		return el;
	}

	// Fallback: first line with height
	for (const el of lines) {
		const r = el.getBoundingClientRect();
		if (r.height > 0) return el;
	}

	return null;
}

/**
 * Correct per-wrapper --sidenote-offset for sidenotes inside indented
 * containers (li, blockquote, callout).  Called AFTER updateSidenotePositioning
 * so that the global --sidenote-offset on the root is already set.
 *
 * Uses the SAME refLine search logic as updateSidenotePositioning to
 * guarantee consistency. The global offset positions sidenotes relative
 * to refLine. For wrappers inside an indented parent, position:absolute
 * resolves against that parent instead, so we compute a per-wrapper
 * offset that compensates for the difference.
 */

/**
 * Correct per-wrapper --sidenote-offset for sidenotes inside indented
 * containers (li, blockquote, callout).  Called AFTER updateSidenotePositioning
 * so that the global --sidenote-offset on the root is already set.
 *
 * Uses the SAME refLine search logic as updateSidenotePositioning to
 * guarantee consistency. The global offset positions sidenotes relative
 * to refLine. For wrappers inside an indented parent, position:absolute
 * resolves against that parent instead, so we compute a per-wrapper
 * offset that compensates for the difference.
 */
export function correctIndentedSidenotePositions(
	settings: SidenoteSettings,
	root: HTMLElement,
) {
	const position = settings.sidenotePosition;

	// Read the global offsets that updateSidenotePositioning just set
	const globalOffset =
		parseFloat(root.style.getPropertyValue("--sidenote-offset")) || 0;
	const globalOffsetLeft =
		parseFloat(root.style.getPropertyValue("--sidenote-offset-left")) ||
		0;
	const globalOffsetRight =
		parseFloat(root.style.getPropertyValue("--sidenote-offset-right")) ||
		0;

	const wrappers = root.querySelectorAll<HTMLElement>(
		"span.sidenote-number",
	);

	for (const wrapper of Array.from(wrappers)) {
		const indentedParent = wrapper.closest<HTMLElement>(
			// Must match the elements styles.css makes `position: relative`,
			// since the shift below compensates for the wrapper resolving
			// against one of them. `.callout-content` was measured here
			// previously while the CSS positions `.callout` — the two differ by
			// the callout's padding and border.
			"li, blockquote, .callout",
		);

		if (!indentedParent) {
			// Not indented — inherit the global offsets
			wrapper.style.removeProperty("--sidenote-offset");
			wrapper.style.removeProperty("--sidenote-offset-left");
			wrapper.style.removeProperty("--sidenote-offset-right");
			continue;
		}

		// Baseline: the top-level preview section this sidenote lives in.
		//
		// Deliberately per-wrapper rather than one document-wide reference
		// element. A global baseline has to be *found*, and both ways of
		// finding it are wrong somewhere: the first visible paragraph may not
		// exist partway down a long list (leaving indented notes uncorrected,
		// so they cut into the text), and the preview sizer is not the text
		// column when a theme centres content within it (over-correcting, so
		// they fly off the side).
		//
		// A section div is a direct child of the sizer, spans exactly the body
		// text column for its region, and is always present — no scanning, no
		// dependence on what happens to be scrolled into view.
		const section = wrapper.closest<HTMLElement>(
			".markdown-preview-sizer > div",
		);
		if (!section) continue;

		const refRect = section.getBoundingClientRect();
		const parentRect = indentedParent.getBoundingClientRect();

		// Left-margin offset is relative to refEl's left edge; this wrapper
		// resolves position:absolute against indentedParent, so shift by how
		// much further right the parent is vs refEl.
		const shiftLeft = parentRect.left - refRect.left;
		// Right-margin offset is relative to refEl's right edge; shift by how
		// much further left the parent's right edge is vs refEl.
		const shiftRight = refRect.right - parentRect.right;

		wrapper.style.setProperty(
			"--sidenote-offset-left",
			pxRounded(globalOffsetLeft - shiftLeft),
		);
		wrapper.style.setProperty(
			"--sidenote-offset-right",
			pxRounded(globalOffsetRight - shiftRight),
		);
		wrapper.style.setProperty(
			"--sidenote-offset",
			pxRounded(
				globalOffset - (position === "left" ? shiftLeft : shiftRight),
			),
		);
	}
}

/**
 * Find an HTML sidenote in the source by its text content.
 * Returns the match details or null if not found.
 */

/**
 * Calculate and apply the vertical offset so the sidenote aligns with
 * the specific line where the reference appears, not the top of the paragraph.
 */
export function applyLineOffset(
	wrapper: HTMLElement,
	margin: HTMLElement,
	isEditingMode: boolean = false,
) {
	if (isEditingMode) {
		// In editing mode, sidenotes are inside .cm-line which already has position: relative
		// The wrapper is inline within the line, so we need to find the offset within the line
		const line = wrapper.closest<HTMLElement>(".cm-line");
		if (!line) return;

		// Get positions
		const wrapperRect = wrapper.getBoundingClientRect();
		const lineRect = line.getBoundingClientRect();

		// The offset is how far down the wrapper is from the top of the line
		// For single-line content this is ~0, for wrapped text it could be more
		const lineOffset = wrapperRect.top - lineRect.top;

		margin.style.setProperty(
			"--sidenote-line-offset",
			`${lineOffset}px`,
		);
	} else {
		// Reading mode: anchor to the nearest positioning context that *you* define in CSS
		const positionedParent =
			wrapper.closest(
				"p, li, h1, h2, h3, h4, h5, h6, blockquote, .callout",
			) ?? wrapper.parentElement;

		if (!positionedParent) return;

		// For inline content, prefer the first line box rect (more stable than getBoundingClientRect)
		const rects = wrapper.getClientRects();
		const wrapperRect = rects.length > 0 ? rects.item(0) : null;
		const effectiveWrapperRect =
			wrapperRect ?? wrapper.getBoundingClientRect();

		// An inline element with no in-flow content produces no client rects,
		// and getBoundingClientRect then returns all zeros. Subtracting the
		// parent's top from that yields a large negative offset that throws the
		// margin far off the top of the note. A real element essentially never
		// sits at exactly (0, 0), so treat that as "no measurement" and anchor
		// to the parent instead.
		const isDegenerate =
			effectiveWrapperRect.top === 0 &&
			effectiveWrapperRect.left === 0 &&
			effectiveWrapperRect.width === 0 &&
			effectiveWrapperRect.height === 0;

		if (isDegenerate) {
			setCssProps(margin, { "--sidenote-line-offset": "0px" });
			return;
		}

		const parentRect = positionedParent.getBoundingClientRect();
		const lineOffset = effectiveWrapperRect.top - parentRect.top;

		margin.style.setProperty(
			"--sidenote-line-offset",
			`${lineOffset}px`,
		);
	}
}

/**
 * Remove all sidenote markup from reading mode to allow fresh processing.
 */

export function calculateMode(
	settings: SidenoteSettings,
	width: number,
): "hidden" | "compact" | "normal" | "full" {
	const s = settings;
	// Sanity check: if width is 0 or unreasonably small, hide
	if (width <= 0 || width < 200) {
		return "hidden";
	}
	if (width < s.hideBelow) {
		return "hidden";
	} else if (width < s.compactBelow) {
		return "compact";
	} else if (width < s.fullAbove) {
		return "normal";
	} else {
		return "full";
	}
}


export function calculateScaleFactor(
	settings: SidenoteSettings,
	width: number,
): number {
	const s = settings;
	if (width < s.hideBelow) {
		return 0;
	}
	return Math.min(
		1,
		(width - s.hideBelow) / (s.fullAbove - s.hideBelow),
	);
}

