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
 * Only `updateSidenotePositioning` uses this, as the reading-mode text
 * column: the element it returns is the positioning context the offsets are
 * resolved against, which is the whole reason they are measured from it. Do
 * not swap in a container box (the sizer, the scroller) as a measurement
 * baseline — see the comment on textLeft/textRight there, and the one in
 * `correctIndentedSidenotePositions`, for why that goes wrong.
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
	// Gates the --page-offset padding rules in styles.css: at 0, those rules
	// should not apply at all (see the comment there), not apply and resolve
	// to a padding of literal 0.
	root.dataset.sidenotePageOffset =
		settings.pageOffsetFactor > 0 ? "true" : "false";

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
	root.style.removeProperty("--sidenote-width");
	root.dataset.sidenoteMode = "";
	root.dataset.hasSidenotes = "";
	root.dataset.sidenotePosition = "";
	root.dataset.sidenoteHasOpposite = "";
	root.dataset.sidenotePageOffset = "";
	root.dataset.sidenoteNoRoom = "";
}

/**
 * Calculate and apply sidenote positioning based on anchor mode and gaps.
 *
 * The two anchor modes trade off position against width when
 * `sidenoteGap`/`sidenoteGap2` can't both be satisfied — which one gives is
 * the entire difference between them:
 *
 * - TEXT ANCHOR: position is what moves. The note's near edge sits exactly
 *   `sidenoteGap` (plus drift) from the text — its width is the
 *   settings-driven natural width, never adjusted — so the note tracks the
 *   text and, in turn, "Page offset factor" when that shifts the text. It
 *   stops at `sidenoteGap2` from the pane's physical edge, giving up some
 *   of the text gap rather than sliding out against the edge.
 * - EDGE ANCHOR: width is what moves. The note's near edge always sits
 *   exactly `sidenoteGap2` from the pane's physical edge — full stop, never
 *   adjusted, so it's independent of the text, drift, and "Page offset
 *   factor" alike. If the resulting gap to text would come in under
 *   `sidenoteGap`, the note's WIDTH shrinks (down to `minSidenoteWidth`,
 *   below which the note hides — see `data-sidenote-no-room`) so the gap
 *   promise holds without moving the note.
 *
 * `sidenoteGap2` therefore constrains both modes; the difference is whether
 * it's the fixed position (edge) or the outermost one allowed (text).
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

	// Drift widens gap1 (the text-side gap) as the editor grows — it never
	// touches gap2 (see below): sidenoteGap2 is a fixed distance from the
	// pane edge in edge-anchor mode, full stop, not something that should
	// grow with editor width. In text-anchor mode gap1 is what the note's
	// position is built from, so drift moves the note; in edge-anchor mode
	// gap1 only feeds the width cap below, so drift there can only shrink
	// the note, never move it.
	const gap1 = Math.max(0, baseGap1 + gapGrowth);

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

	// Clear any width clamp a PREVIOUS pass left in place before measuring,
	// so "natural" below reflects the current settings-driven cascade (base
	// width + editor-width-driven scale) rather than last frame's shrink —
	// otherwise a note that once shrank could never grow back.
	root.style.removeProperty("--sidenote-width");
	const naturalWidth = getSidenoteWidthPx(settings, root);

	// Compute both sides unconditionally so a per-sidenote override can
	// place an individual note in the margin opposite the document-wide
	// "Sidenote position" setting.

	// The text column edges, taken from refLine's OWN rect.
	//
	// This has to be refLine and nothing else: every offset this function
	// writes is consumed as `left`/`right` on a position:absolute
	// `.sidenote-margin`, whose containing block is the .cm-line (editing)
	// or p/li/callout (reading) the note sits in — refLine is a stand-in for
	// exactly that box, which is why correctIndentedSidenotePositions
	// measures its per-wrapper corrections against refLine too.
	//
	// It used to come from getEditorTextEdges/getReadingTextLeft — the
	// scroller's (or sizer's) padding edge — which is a DIFFERENT frame the
	// moment a theme centres the text column inside that box. Obsidian's
	// "Readable line length" does exactly that, via max-width + auto margins
	// on .cm-sizer, so in editing mode the padding edge sat hundreds of
	// pixels left of the real text. Mixing the two frames is what put
	// sidenotes on top of the body text: `editorEdgeLeft - textLeft` came
	// out as 0 (both were the scroller's edge), and the pane-edge clamp
	// below then pinned the note's left edge to the text's own left edge.
	//
	// One exception: findReadingRefElement falls back to the preview sizer
	// itself when it can't find a visible block. That box is a container,
	// not a text column — its border box sits outside its own page padding —
	// so strip that padding to land on the same edges a <p> inside it would
	// have had.
	const sizerFallbackEdges =
		isReadingMode &&
		refLine.classList.contains("markdown-preview-sizer")
			? getReadingTextEdges(root)
			: null;
	const textLeft = sizerFallbackEdges?.left ?? refRect.left;
	const textRight = sizerFallbackEdges?.right ?? refRect.right;

	// The real editor edge (scroller/view), not rootRect.left, which may
	// already carry the page-offset padding.
	const editorEdgeLeft = (() => {
		if (isReadingMode) return root.getBoundingClientRect().left;
		const scroller = root.querySelector<HTMLElement>(".cm-scroller");
		return (scroller ?? root).getBoundingClientRect().left;
	})();

	const editorEdgeRight = (() => {
		if (isReadingMode) return root.getBoundingClientRect().right;

		const scroller = root.querySelector<HTMLElement>(".cm-scroller");
		return (scroller ?? root).getBoundingClientRect().right;
	})();

	// In edge-anchor mode, shrink the (single, shared-between-sides) width
	// instead of moving the note when sidenoteGap2 (position) and
	// sidenoteGap (the minimum gap to text) can't both be honored at the
	// natural width. Only the sides actually in use constrain it — an unused
	// margin's tightness shouldn't shrink a note that isn't there.
	//
	// `--sidenote-width` has always been one shared value for every
	// sidenote regardless of side (see its CSS definition), so a single
	// shared cap here matches that existing granularity rather than adding
	// finer-grained control the rest of the system doesn't have.
	let sidenoteWidth = naturalWidth;
	let noRoom = false;
	if (anchorMode === "edge") {
		let widthCap = Infinity;
		if (sides.left) {
			widthCap = Math.min(
				widthCap,
				textLeft - editorEdgeLeft - baseGap2 - gap1,
			);
		}
		if (sides.right) {
			widthCap = Math.min(
				widthCap,
				editorEdgeRight - textRight - baseGap2 - gap1,
			);
		}
		if (widthCap !== Infinity) {
			sidenoteWidth = Math.max(0, Math.min(naturalWidth, widthCap));
			if (sidenoteWidth < s.minSidenoteWidth * remToPx) {
				noRoom = true;
			}
			if (sidenoteWidth !== naturalWidth) {
				root.style.setProperty(
					"--sidenote-width",
					pxRounded(sidenoteWidth),
				);
			}
		}
	}
	// Gates a CSS rule that hides `.sidenote-margin` outright — deliberately
	// separate from `data-sidenote-mode="hidden"` (the too-narrow-editor
	// case), which also switches off `--page-offset`. This is a lateral-room
	// problem only: the text shift "Page offset factor" already reserved is
	// still exactly as valid as it was, so it must stay in effect.
	root.dataset.sidenoteNoRoom = noRoom ? "true" : "false";

	// The edge-anchored position for each side: the note's outer edge exactly
	// sidenoteGap2 in from the pane's physical edge.
	//
	// Each is written in its OWN side's sign convention, and they are
	// mirrors, not copies. `left` grows rightward from the containing
	// block's left edge, so the offset is (target - textLeft); `right` grows
	// LEFTWARD from its right edge, so the offset is (textRight - target).
	// Writing the right one as a straight copy of the left
	// (`editorEdgeRight - gap2 - textRight`) is the negation of the correct
	// value: it put the note's right edge at 2*textRight - editorEdgeRight +
	// gap2, i.e. deep inside the body text instead of out in the margin.
	const edgeAnchoredLeft = editorEdgeLeft + baseGap2 - textLeft;
	const edgeAnchoredRight = textRight - editorEdgeRight + baseGap2;

	// Text-anchored: the note's near edge sits gap1 from the text. One value
	// for both sides — each side's sign convention already points its offset
	// outward, away from the text.
	const textAnchored = -(gap1 + sidenoteWidth);

	// In text-anchor mode the note holds its gap to the text right up until
	// that would carry it past sidenoteGap2 from the pane edge, and then it
	// stops there: sidenoteGap2 is a minimum distance from the editor edge
	// in BOTH modes — edge anchor just makes it the fixed position rather
	// than a floor. In a pane too narrow for both gaps this gives up some of
	// the text gap, since text anchor never adjusts width and something has
	// to yield; what it buys is a note that stays in the margin instead of
	// sliding out to sit flush against (or past) the pane's edge.
	const cssLeft =
		anchorMode === "text"
			? Math.max(textAnchored, edgeAnchoredLeft)
			: edgeAnchoredLeft;
	const cssRight =
		anchorMode === "text"
			? Math.max(textAnchored, edgeAnchoredRight)
			: edgeAnchoredRight;

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
 * Only used for the sizer fallback in `updateSidenotePositioning` — when
 * `findReadingRefElement` couldn't find a real block and handed back the
 * sizer itself. The sizer's *border* box is not the text column: it sits
 * outside the padding, and using it as a baseline inflates every
 * measurement by that padding.
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
/**
 * Walk up from `el` to the nearest ancestor the browser will actually use as
 * the containing block for one of its `position: absolute` descendants —
 * i.e. the first ancestor whose computed `position` isn't `static`.
 *
 * Used instead of a fixed tag/class selector (`li, blockquote, .callout`)
 * because that list can skip right past the TRUE containing block. styles.css
 * gives `<p>` its own `position: relative` unconditionally, and Obsidian
 * wraps callout body text in `.callout-content > p` — so for a sidenote
 * inside a callout, the nearest positioned ancestor is that `<p>`, not
 * `.callout` itself, and the two differ by the callout's own padding/border
 * (its icon inset, on the left). Measuring `.callout` there computed a
 * shift of zero — no correction at all — and the sidenote rendered off in
 * the callout's padding instead of the margin. Same issue for blockquotes,
 * which get the identical `<p>`-wrapped treatment.
 */
function findPositionedAncestor(el: HTMLElement): HTMLElement | null {
	let node = el.parentElement;
	while (node) {
		if (getComputedStyle(node).position !== "static") return node;
		node = node.parentElement;
	}
	return null;
}

export function correctIndentedSidenotePositions(
	settings: SidenoteSettings,
	root: HTMLElement,
	isReadingMode: boolean,
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

	// Editing mode has no .markdown-preview-sizer to look a per-wrapper
	// baseline up in (see the section lookup below) — CM6 is its own
	// virtualised world of .cm-line elements instead. findStableCmRefLine is
	// the same single reference line updateSidenotePositioning already used
	// to compute the global offsets read above, so reusing it here keeps the
	// correction measured against the exact baseline it's correcting.
	const editingRefLine = isReadingMode ? null : findStableCmRefLine(root);

	const wrappers = root.querySelectorAll<HTMLElement>(
		"span.sidenote-number",
	);

	for (const wrapper of Array.from(wrappers)) {
		const indentedParent = findPositionedAncestor(wrapper);

		if (!indentedParent) {
			// Not indented — inherit the global offsets
			wrapper.style.removeProperty("--sidenote-offset");
			wrapper.style.removeProperty("--sidenote-offset-left");
			wrapper.style.removeProperty("--sidenote-offset-right");
			continue;
		}

		// Baseline this wrapper's shift is measured against.
		//
		// Reading mode: the top-level preview section this sidenote lives in,
		// found per-wrapper rather than once for the whole document. A global
		// baseline has to be *found*, and both ways of finding it are wrong
		// somewhere: the first visible paragraph may not exist partway down a
		// long list (leaving indented notes uncorrected, so they cut into the
		// text), and the preview sizer is not the text column when a theme
		// centres content within it (over-correcting, so they fly off the
		// side). A section div is a direct child of the sizer, spans exactly
		// the body text column for its region, and is always present — no
		// scanning, no dependence on what happens to be scrolled into view.
		//
		// Editing mode: no per-wrapper equivalent exists (CM6 has no
		// .markdown-preview-sizer), so this reuses editingRefLine — the same
		// single reference line the global offset was already computed from.
		const section = isReadingMode
			? wrapper.closest<HTMLElement>(".markdown-preview-sizer > div")
			: editingRefLine;
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
		// In editing mode, sidenotes are normally inside .cm-line, which
		// already has position: relative. A sidenote inside a callout has no
		// .cm-line ancestor at all though — Obsidian renders the callout as
		// a single replaced block widget (.callout-content > p, same as
		// reading mode), not per-line elements — so this falls back to
		// whatever .callout p/li/blockquote/.callout position:relative CSS
		// resolves to instead (see findPositionedAncestor's own comment).
		// Without it this returned early and --sidenote-line-offset was
		// simply never set for a callout-nested sidenote.
		const line =
			wrapper.closest<HTMLElement>(".cm-line") ??
			findPositionedAncestor(wrapper);
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

