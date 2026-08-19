/**
 * Editing-mode (Live Preview) rendering for HTML-format sidenotes.
 *
 * The footnote formats are handled by the CM6 widget in `widgets.ts`; this
 * module only covers `<span class="sidenote">` markup, which has no widget and
 * has to be wrapped in the DOM directly.
 */

import { MarkdownView } from "obsidian";
import type { App, PluginManifest } from "obsidian";
import type { SidenoteSettings } from "./settings";
import {
	type SidenoteSide,
	formatNumber,
	getSidenoteSideOverride,
	isMarginNote,
	normalizeText,
	renderLinksToFragment,
} from "./content";
import {
	type SidenoteMode,
	applyLineOffset,
	correctIndentedSidenotePositions,
	updateSidenotePositioning,
} from "./layout-math";
import { updateCollisionsIn } from "./collision-runner";
import {
	type TeardownHooks,
	removeEditingModeMarkup,
} from "./teardown";
import { SIDENOTE_SPAN_REGEX } from "./patterns";

/**
 * What editing-mode rendering needs from the plugin. An interface the plugin
 * implements, not a snapshot — `isMutating` and `lastSidenoteCount` are
 * written back, and the document-state fields change between passes.
 */
export interface EditingModeContext extends TeardownHooks {
	readonly app: App;
	readonly manifest: PluginManifest;
	readonly settings: SidenoteSettings;
	readonly documentHasSidenotes: boolean;
	readonly documentSidenoteSides: Record<SidenoteSide, boolean>;

	/** Suppresses the plugin's own `.cm-content` MutationObserver. */
	isMutating: boolean;
	lastSidenoteCount: number;

	getMarkdownView(): MarkdownView | null;
	getDocumentPosition(el: HTMLElement): number | null;
	observeSidenoteVisibility(margin: HTMLElement): void;
	setupMarginEditing(
		margin: HTMLElement,
		sourceSpan: HTMLElement,
		docPos: number | null,
		sidenoteIndex: number,
	): void;
	setupSidenoteClickHandler(
		wrapper: HTMLElement,
		sidenoteText: string,
	): void;
	setupMarginNotePopup(
		wrapper: HTMLElement,
		margin: HTMLElement,
		contentText: string,
		editable?: boolean,
		footnoteId?: string,
	): void;
	startMarginEdit(
		margin: HTMLElement,
		sourceSpan: HTMLElement,
		sidenoteIndex: number,
		clickEvent?: MouseEvent,
	): void;
}

/**
 * Position editing-mode sidenotes once the DOM has settled.
 *
 * Deferred twice: once to let the browser insert elements, once to lay them
 * out. Written out three times in `layout()` before this was extracted.
 */
export function positionEditingSidenotes(
	ctx: EditingModeContext,
	cmRoot: HTMLElement,
) {
	window.requestAnimationFrame(() => {
		window.requestAnimationFrame(() => {
			if (!cmRoot.isConnected) return;
			updateSidenotePositioning(
				ctx.settings,
				ctx.documentSidenoteSides,
				cmRoot,
				false,
			);
			// Reading mode's counterpart already ran this; editing mode never
			// did, which is why a callout-nested sidenote positioned as if it
			// were a top-level paragraph in Live Preview even after reading
			// mode was fixed. Must run after updateSidenotePositioning, which
			// sets the global --sidenote-offset this reads and corrects.
			correctIndentedSidenotePositions(ctx.settings, cmRoot, false);
			// The captured root, not this.cmRoot — the active leaf may have
			// changed between scheduling this frame and running it.
			updateCollisionsIn(ctx.settings, cmRoot);
		});
	});
}

/**
 * Editing-mode HTML sidenotes: wrap any unwrapped spans, build their
 * margins, and position the result.
 *
 * A pass that finds new spans renumbers everything from scratch, because
 * sidenote numbers are positional and inserting one shifts every number
 * after it.
 */
export function buildEditingHtmlSidenotes(
	ctx: EditingModeContext,
	cmRoot: HTMLElement,
	mode: SidenoteMode,
) {
	// HTML sidenote processing (existing logic)
	cmRoot.dataset.hasSidenotes = ctx.documentHasSidenotes
		? "true"
		: "false";

	const unwrappedSpans = Array.from(
		cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
	).filter(
		(span) => !span.parentElement?.classList.contains("sidenote-number"),
	);
	// console.warn(unwrappedSpans.length, "unwrapped sidenote spans found");
	// If there are new sidenotes to process, we need to renumber everything
	if (unwrappedSpans.length > 0 && mode !== "hidden") {
		// Remove all existing sidenote wrappers and margins to renumber from scratch
		removeEditingModeMarkup(ctx, cmRoot);

		// Get the source content to determine correct indices
		const view = ctx.getMarkdownView();
		if (!view?.editor) return;

		const content = view.editor.getValue();

		// Build a map of sidenote text content + position to their index
		const sidenoteIndexMap = buildSidenoteOnlyIndexMap(content);

		// Now get ALL sidenote spans (they're all unwrapped now)
		const allSpans = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		);

		if (allSpans.length === 0) {
			ctx.lastSidenoteCount = 0;
			return;
		}

		// Collect all sidenotes to process
		const allItems = allSpans.map((el) => ({
			el,
			docPos: ctx.getDocumentPosition(el),
			text: el.textContent ?? "",
		}));

		// Match each visible item to its index in the full document
		const itemsWithIndex = allItems.map((item) => {
			const index = findSidenoteIndex(
				sidenoteIndexMap,
				item.text,
				item.docPos,
			);
			return { ...item, index };
		});

		// Assign source index BEFORE sorting (DOM order = source order)
		let sourceCounter = 1;
		const itemsWithSourceIndex = itemsWithIndex.map((item) => ({
			...item,
			sourceIndex: sourceCounter++,
		}));

		// Sort by index for consistent display ordering
		itemsWithSourceIndex.sort((a, b) => a.index - b.index);

		ctx.isMutating = true;
		try {
			for (const item of itemsWithSourceIndex) {
				const isMargin = isMarginNote(item.el);
				const sideOverride = getSidenoteSideOverride(item.el);
				const numStr = isMargin ? "" : formatNumber(item.index, ctx.settings.numberStyle);
				const wrapper = createSpan();
				wrapper.className = "sidenote-number";
				const margin = createEl("small");
				margin.className = "sidenote-margin";

				if (isMargin) {
					wrapper.classList.add("margin-note");
					margin.classList.add("margin-note");
				}
				if (sideOverride) {
					wrapper.dataset.sidenoteSide = sideOverride;
					margin.dataset.sidenoteSide = sideOverride;
				}

				wrapper.dataset.sidenoteNum = numStr;
				margin.dataset.sidenoteNum = numStr;

				if (isMargin) {
					const marker = createSpan();
					marker.className = "margin-note-marker";

					const iconSetting = ctx.settings.popupIcon || "ⓘ";

					if (
						iconSetting.endsWith(".png") ||
						iconSetting.endsWith(".svg") ||
						iconSetting.endsWith(".jpg")
					) {
						const img = createEl("img");
						img.src = ctx.app.vault.adapter.getResourcePath(
							`${ctx.manifest.dir}/assets/${iconSetting}`,
						);
						img.className = "margin-note-marker-img";
						marker.appendChild(img);
					} else {
						marker.textContent = iconSetting;
					}

					if (ctx.settings.marginNoteDisplay === "popup") {
						marker.addEventListener("click", (e) => {
							e.preventDefault();
							e.stopPropagation();
							// Find the popup icon in the margin and click it
							const popupIcon = margin.querySelector<HTMLElement>(
								".margin-note-icon",
							);
							if (popupIcon) popupIcon.click();
						});
					} else {
						marker.addEventListener("click", (e) => {
							e.preventDefault();
							e.stopPropagation();
							ctx.startMarginEdit(margin, item.el, item.index, e);
						});
					}
					marker.addEventListener("mousedown", (e) => {
						e.stopPropagation();
					});
					wrapper.appendChild(marker);
				}

				const raw = normalizeText(item.el.textContent ?? "");
				margin.appendChild(renderLinksToFragment(raw, ctx.app));

				// Setup popup AFTER margin has content
				if (isMargin && ctx.settings.marginNoteDisplay === "popup") {
					ctx.setupMarginNotePopup(wrapper, margin, item.text, true);
				}
				// Make margin editable and set up edit handling
				ctx.setupMarginEditing(
					margin,
					item.el,
					item.docPos,
					item.index,
				);

				// Add click handler to select only text content
				ctx.setupSidenoteClickHandler(wrapper, item.text);

				item.el.parentNode?.insertBefore(wrapper, item.el);
				wrapper.appendChild(item.el);
				wrapper.appendChild(margin);

				// Calculate line offset for this sidenote (editing mode)
				applyLineOffset(wrapper, margin, true);

				ctx.observeSidenoteVisibility(margin);
			}
		} finally {
			ctx.isMutating = false;
		}

		ctx.lastSidenoteCount =
			cmRoot.querySelectorAll(".sidenote-margin").length;

		// Run positioning and collision avoidance after DOM is settled
		positionEditingSidenotes(ctx, cmRoot);
	} else {
		// No new sidenotes to process
		ctx.lastSidenoteCount =
			cmRoot.querySelectorAll(".sidenote-margin").length;

		if (ctx.lastSidenoteCount > 0 && mode !== "hidden") {
			// Still run positioning and collision avoidance for existing sidenotes
			positionEditingSidenotes(ctx, cmRoot);
		}
}
}

/**
 * Build a map of sidenotes only (not footnotes) in the source document.
 * Used for editing mode where footnote conversion is disabled.
 */
function buildSidenoteOnlyIndexMap(content: string): {
	index: number;
	charPos: number;
	text: string;
	isMarginNote: boolean;
}[] {
	const items: {
		index: number;
		charPos: number;
		text: string;
		isMarginNote: boolean;
	}[] = [];

	// Find all sidenotes (including margin-note variant)
	const sidenoteRegex = SIDENOTE_SPAN_REGEX();
	let match: RegExpExecArray | null;

	while ((match = sidenoteRegex.exec(content)) !== null) {
		const isMargin = /margin-note/.test(match[0]);
		items.push({
			index: 0,
			charPos: match.index,
			text: normalizeText(match[1] ?? ""),
			isMarginNote: isMargin,
		});
	}

	// Sort by position and assign indices (only numbered sidenotes get incremented)
	items.sort((a, b) => a.charPos - b.charPos);
	let counter = 1;
	items.forEach((item) => {
		if (item.isMarginNote) {
			item.index = -1; // Margin notes have no number
		} else {
			item.index = counter++;
		}
	});

	return items;
}

/**
 * Find the index of a sidenote in the document based on its text and approximate position.
 */
function findSidenoteIndex(
	sidenoteMap: {
		index: number;
		charPos: number;
		text: string;
		isMarginNote?: boolean;
	}[],
	text: string,
	docPos: number | null,
): number {
	const normalizedText = normalizeText(text);

	// Find all sidenotes with matching text
	const matchingByText = sidenoteMap.filter(
		(s) => s.text === normalizedText,
	);

	if (matchingByText.length === 1) {
		const match = matchingByText[0];
		if (match) {
			return match.index;
		}
	}

	if (matchingByText.length > 1 && docPos !== null) {
		const approxCharPos = Math.floor(docPos / 10000);
		let closest: {
			index: number;
			charPos: number;
			text: string;
		} | null = null;
		let closestDist = Infinity;

		for (const s of matchingByText) {
			const dist = Math.abs(s.charPos - approxCharPos);
			if (dist < closestDist) {
				closestDist = dist;
				closest = s;
			}
		}

		if (closest) {
			return closest.index;
		}
	}

	// Fallback: return next available index
	const maxIndex = sidenoteMap.reduce(
		(max, s) => Math.max(max, s.index),
		0,
	);
	return maxIndex + 1;
}
