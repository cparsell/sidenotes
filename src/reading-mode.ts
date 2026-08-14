/**
 * Reading-mode rendering: find the sidenotes in a rendered preview, build a
 * margin for each, and position the result.
 *
 * Render-only. Sidenote *editing* in reading mode was removed — reading mode
 * has no editor behind it, so writes had to go through `vault.process` and then
 * race Obsidian's preview re-render. Do not reintroduce it.
 *
 * Free functions taking an explicit context rather than a class: once the
 * editing paths were gone there was no mutable state left here worth owning.
 */

import { MarkdownView } from "obsidian";
import type { App } from "obsidian";
import type { SidenoteSettings } from "./settings";
import {
	type SidenoteSide,
	buildSourceRefOrder,
	formatNumber,
	getSidenoteSideOverride,
	isMarginNote,
	normalizeText,
	parseFootnoteDefinitions,
	renderLinksToFragment,
	resolveFootnoteBaseId,
	stripSideSuffix,
} from "./content";
import {
	applyLineOffset,
	correctIndentedSidenotePositions,
	updateSidenotePositioning,
} from "./layout-math";
import { updateCollisionsIn } from "./collision-runner";
import { SIDENOTE_SPAN_REGEX } from "./patterns";

/** A sidenote span or footnote reference in the reading view, ready to wrap. */
export interface ReadingItem {
	el: HTMLElement;
	rect: DOMRect;
	type: "sidenote" | "footnote";
	text: string;
	rawText?: string;
	/** Position among all sidenote spans in the document (HTML format). */
	docIndex?: number;
	footnoteId?: string;
	footnoteHtml?: HTMLElement;
}

export interface ReadingItemCollection {
	items: ReadingItem[];
	/** Source-order footnote IDs, for mapping rendered numbers back. */
	sourceRefOrder: string[];
	/** Sidenote number per document position; 0 for margin notes. */
	htmlNumberByIndex: number[];
}

/**
 * What reading-mode rendering needs from the plugin.
 *
 * An interface the plugin implements, not a snapshot: the document-state
 * fields change between passes, and a frozen copy would render stale values.
 */
export interface ReadingModeContext {
	readonly app: App;
	readonly settings: SidenoteSettings;
	readonly documentSidenoteSides: Record<SidenoteSide, boolean>;
	readonly headingSidenoteNumbers: Map<string, number>;

	getMarkdownView(): MarkdownView | null;
	getSourceText(): string;
	setCachedSource(content: string, path: string | null): void;
	scheduleFootnoteProcessing(): void;
	observeSidenoteVisibility(margin: HTMLElement): void;
	setupMarginNotePopup(
		wrapper: HTMLElement,
		margin: HTMLElement,
		contentText: string,
		editable?: boolean,
		footnoteId?: string,
	): void;
}

/**
 * Position every sidenote in the reading root: line offsets, the global
 * offset, the per-wrapper indent correction, then collision resolution.
 *
 * This sequence was written out three times — the early-exit reposition,
 * the tail of a build pass, and the reading-mode layout pass — and had
 * already drifted: only one of them recomputed line offsets or cleared
 * `is-placing`.
 *
 * `recomputeLineOffsets` is only needed when margins were just built or
 * moved; a settings or resize reposition can skip that measurement pass.
 */
export function positionReadingSidenotes(
	ctx: ReadingModeContext,
	readingRoot: HTMLElement,
	opts: { recomputeLineOffsets: boolean },
) {
	if (!readingRoot.isConnected) return;

	// Force reflow so measurements are accurate
	void readingRoot.offsetHeight;

	if (opts.recomputeLineOffsets) {
		const wrappers = readingRoot.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);
		for (const wrapper of Array.from(wrappers)) {
			const margin = wrapper.querySelector<HTMLElement>(
				"small.sidenote-margin",
			);
			if (margin) {
				applyLineOffset(wrapper, margin, false);
			}
		}
	}

	updateSidenotePositioning(
		ctx.settings,
		ctx.documentSidenoteSides,
		readingRoot,
		true,
	);
	correctIndentedSidenotePositions(ctx.settings, readingRoot);

	// All margins in the DOM, not just newly created ones, so collisions
	// between old and new sidenotes are resolved. Deliberately the same
	// root the positioning above measured — re-resolving getReadingRoot()
	// here could return a different view's root if the active leaf changed
	// before this frame ran.
	updateCollisionsIn(ctx.settings, readingRoot);

	// Commit those positions with transitions still suppressed, then
	// re-enable them so later changes (settings, resize) do animate.
	void readingRoot.offsetHeight;
	readingRoot
		.querySelectorAll<HTMLElement>("small.sidenote-margin.is-placing")
		.forEach((m) => m.classList.remove("is-placing"));
}

/**
 * Map each mounted sidenote span onto its index in the source list.
 *
 * The mounted spans are a subsequence of the source spans in the same order,
 * so a forward-only cursor resolves repeated text correctly — matching from
 * the start each time would collapse duplicates onto the first occurrence.
 *
 * Matching is on *rendered* text: the source holds markdown (`**bold**`) while
 * the DOM holds what it renders to (`bold`), so the source side is run through
 * the same renderer before comparing.
 *
 * If a span cannot be matched — source and DOM briefly out of sync, or markup
 * this renderer does not reproduce — it takes the cursor position and the walk
 * continues, so a run of unmatched spans still gets distinct indices instead
 * of all collapsing onto one.
 */
function matchSpansToSource(
	ctx: ReadingModeContext,
	spans: HTMLElement[],
	sourceSpans: { text: string; isMargin: boolean }[],
): number[] {
	const rendered = sourceSpans.map((s) =>
		normalizeText(
			renderLinksToFragment(normalizeText(s.text), ctx.app).textContent ??
				"",
		),
	);

	const out: number[] = [];
	let cursor = 0;

	for (const span of spans) {
		const text = normalizeText(span.textContent ?? "");
		let found = -1;
		for (let i = cursor; i < rendered.length; i++) {
			if (rendered[i] === text) {
				found = i;
				break;
			}
		}
		if (found === -1) found = cursor;
		out.push(found);
		cursor = found + 1;
	}

	return out;
}

/**
 * Find every sidenote span / footnote reference in the reading view that
 * still needs wrapping, in document order.
 *
 * Returns `null` when the pass cannot proceed at all — footnote format with
 * no resolvable source text or no definitions, where the source is fetched
 * asynchronously and processing is rescheduled.
 */
export function collectReadingItems(
	ctx: ReadingModeContext,
	readingRoot: HTMLElement,
): ReadingItemCollection | null {
	// Collect items based on the sidenoteFormat setting
	// Note: footnoteHtml is optional and only used for footnotes
	const allItems: {
		el: HTMLElement;
		rect: DOMRect;
		type: "sidenote" | "footnote";
		text: string;
		rawText?: string;
		/** Position among all sidenote spans in the document (HTML format). */
		docIndex?: number;
		footnoteId?: string;
		footnoteHtml?: HTMLElement;
	}[] = [];

	// Determine what to collect
	const useHtmlSidenotes = ctx.settings.sidenoteFormat === "html";
	const useFootnotes =
		ctx.settings.sidenoteFormat === "footnote" ||
		ctx.settings.sidenoteFormat === "footnote-edit";

	// Every HTML sidenote in the SOURCE, in document order.
	//
	// numbering & source-text pairing are both derived from this, never from
	// the mounted DOM. Reading mode virtualises: `querySelectorAll` only sees
	// the spans Obsidian currently has rendered, so a span's position in the
	// DOM is not its position in the document. Indexing off the DOM made the
	// numbering restart partway down a long note (…11, 12, then 1, 2 again)
	// and paired each sidenote with the wrong raw text.
	//
	// Same reasoning as documentHasSidenotes / documentSidenoteSides, which
	// are source-derived for exactly this reason.
	const sourceSpans: { text: string; isMargin: boolean }[] = [];
	if (useHtmlSidenotes) {
		const sourceContent = ctx.getSourceText();
		if (sourceContent) {
			const regex = SIDENOTE_SPAN_REGEX();
			let m: RegExpExecArray | null;
			while ((m = regex.exec(sourceContent)) !== null) {
				sourceSpans.push({
					text: m[1] ?? "",
					isMargin: /margin-note/.test(m[0]),
				});
			}
		}
	}

	// Sidenote number per SOURCE index; 0 for margin notes, which render
	// unnumbered and must not consume a number.
	const htmlNumberByIndex: number[] = [];

	if (useHtmlSidenotes) {
		let seq = 0;
		for (const span of sourceSpans) {
			htmlNumberByIndex.push(span.isMargin ? 0 : ++seq);
		}

		// EVERY sidenote span in the reading root, wrapped or not, in DOM
		// order. An incremental pass only *processes* the unwrapped ones, but
		// it still has to walk all of them so the source cursor stays aligned.
		const allSpans = Array.from(
			readingRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		);

		const sourceIndices = matchSpansToSource(ctx, allSpans, sourceSpans);

		allSpans.forEach((el, i) => {
			// Already wrapped by an earlier pass — nothing to build.
			if (el.parentElement?.classList.contains("sidenote-number")) {
				return;
			}
			const docIndex = sourceIndices[i] ?? i;
			allItems.push({
				el,
				rect: el.getBoundingClientRect(),
				type: "sidenote",
				text: el.textContent ?? "",
				rawText: sourceSpans[docIndex]?.text ?? el.textContent ?? "",
				docIndex,
			});
		});
	}

	const sourceRefOrder: string[] = [];

	if (useFootnotes) {
		// Get footnote definitions from SOURCE MARKDOWN, not from rendered HTML.
		// Obsidian uses virtualized rendering — the <section class="footnotes">
		// may not exist in the DOM for long documents where it's off-screen.

		let sourceContent = ctx.getSourceText();

		// If still empty, try async cachedRead as last resort
		if (!sourceContent) {
			const file =
				ctx.getMarkdownView()?.file ?? ctx.app.workspace.getActiveFile();
			if (file) {
				void ctx.app.vault.cachedRead(file).then((text) => {
					const current =
						ctx.app.workspace.getActiveViewOfType(MarkdownView);
					if (!current || current.file?.path !== file.path) return;
					// Cache the result so the next call succeeds synchronously
					ctx.setCachedSource(text, file.path);
					ctx.scheduleFootnoteProcessing();
				});
			}
			if (!useHtmlSidenotes) return null;
		}

		const definitions = parseFootnoteDefinitions(sourceContent);

		// Build a map from rendered order to source ID.
		//
		// Only refs that actually have a definition: Obsidian leaves a `[^x]`
		// with no matching `[^x]:` as literal text rather than rendering it as
		// a footnote, so counting it here would offset this list against the
		// rendered numbering and mis-map every note after it.
		sourceRefOrder.push(
			...buildSourceRefOrder(sourceContent).filter((id) =>
				definitions.has(id),
			),
		);
		if (definitions.size === 0) {
			if (!useHtmlSidenotes) return null;
		}

		// Find all footnote references in the rendered HTML
		const footnoteSups = readingRoot.querySelectorAll<HTMLElement>(
			// Obsidian preview often uses sup#fnref-* with a.footnote-link
			"sup.footnote-ref, sup[class*='footnote'], sup[id^='fnref-'], sup[data-footnote-id], a.footnote-link",
		);

		const processedBaseIds = new Set<string>();

		for (const sup of Array.from(footnoteSups)) {
			if (sup.closest(".sidenote-number")) continue;
			// Skip elements inside the footnotes section (these are backrefs, not refs)
			if (sup.closest("section.footnotes, .footnotes")) continue;

			// Extract the base footnote ID from the rendered markup
			const renderedId = resolveFootnoteBaseId(sup);
			if (!renderedId || processedBaseIds.has(renderedId)) continue;

			// Map Obsidian's rendered sequential number back to the source
			// footnote ID.
			//
			// Indexing by the rendered number — rather than walking
			// sourceRefOrder with a counter as print-export.ts does — is
			// deliberate: reading mode virtualises, so the refs present in the
			// DOM are only the mounted ones. A counter would restart at 0
			// partway down the note and mis-map everything.
			//
			// Only remap when the rendered markup gave a bare number. A
			// renderedId like "4-r" or "mn-1" is already a source ID, and
			// parseInt would read "4-r" as 4 and then look up whatever ref
			// happens to sit at position 4 — attaching the wrong definition, or
			// none at all, and shifting every note after it.
			let baseId = renderedId;
			const renderedNum = /^\d+$/.test(renderedId)
				? parseInt(renderedId, 10)
				: NaN;
			if (
				!isNaN(renderedNum) &&
				renderedNum >= 1 &&
				renderedNum <= sourceRefOrder.length
			) {
				const sourceId = sourceRefOrder[renderedNum - 1];
				if (sourceId && definitions.has(sourceId)) {
					baseId = sourceId;
				}
			}

			// Mark both original and remapped IDs as processed
			if (processedBaseIds.has(baseId)) continue;
			processedBaseIds.add(renderedId);
			processedBaseIds.add(baseId);

			// Look up definition from SOURCE markdown
			const footnoteText = definitions.get(baseId);
			if (!footnoteText) continue;

			// For footnotes, hide the original [1] link
			const anchor = sup.querySelector("a");
			if (anchor && ctx.settings.hideFootnoteNumbers) {
				anchor.classList.add("sidenote-fn-link-hidden");
			}

			allItems.push({
				el: sup,
				rect: sup.getBoundingClientRect(),
				type: "footnote",
				text: footnoteText,
				footnoteId: baseId,
				// No footnoteHtml — render from source text instead
			});
		}
	}

	return { items: allItems, sourceRefOrder, htmlNumberByIndex };
}

/**
 * Wrap each collected item and build its margin, numbering as it goes.
 */
export function buildReadingMargins(
	ctx: ReadingModeContext,
	allItems: ReadingItem[],
	htmlNumberByIndex: number[],
) {
	let num = 1;

	for (const item of allItems) {
		// Determine if this is a margin note (unnumbered)
		const isMargin =
			item.type === "sidenote"
				? isMarginNote(item.el)
				: item.footnoteId
					? isMarginNote(item.footnoteId)
					: false;

		// HTML sidenotes are numbered by their position in the document,
		// not by their position in this pass's work list — an incremental
		// pass may only be handling one span in the middle of the note.
		if (item.type === "sidenote" && item.docIndex !== undefined) {
			num = htmlNumberByIndex[item.docIndex] ?? num;
		}

		// Margin notes render without a number, so they must not consume
		// one — otherwise they punch gaps in the sequence (…62, 63, 65…).
		if (ctx.settings.resetNumberingPerHeading && !isMargin) {
			const heading = findPrecedingHeading(item.el);
			if (heading) {
				const headingId = getHeadingId(heading);
				if (!ctx.headingSidenoteNumbers.has(headingId)) {
					ctx.headingSidenoteNumbers.set(headingId, 1);
				}
				num = ctx.headingSidenoteNumbers.get(headingId)!;
				ctx.headingSidenoteNumbers.set(headingId, num + 1);
			}
		}

		// Per-sidenote margin override (opposite side from the document-wide setting)
		const sideOverride =
			item.type === "sidenote"
				? getSidenoteSideOverride(item.el)
				: item.footnoteId
					? getSidenoteSideOverride(item.footnoteId)
					: null;

		// For footnotes, use the footnote's own ID as the number
		// (so [^3] always displays as "3" regardless of which refs are visible).
		// For HTML sidenotes, `num` was resolved above — from the document
		// index, or from the per-heading counter when that setting is on.
		// For margin notes, use empty string (no number).
		let numStr: string;
		if (isMargin) {
			numStr = "";
		} else if (item.footnoteId) {
			numStr = stripSideSuffix(item.footnoteId);
		} else {
			numStr = formatNumber(num, ctx.settings.numberStyle);
		}

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

		if (item.footnoteId) {
			wrapper.dataset.footnoteId = item.footnoteId;
		}

		if (item.type === "sidenote") {
			cloneContentToMargin(ctx.app, item.el, margin);
		} else {
			// For footnotes, hide the original [1] link inside the sup
			const anchor = item.el.querySelector("a.footnote-link");
			if (anchor && ctx.settings.hideFootnoteNumbers) {
				anchor.classList.add("sidenote-fn-link-hidden");
			}

			// Render from source markdown text
			margin.appendChild(
				renderLinksToFragment(normalizeText(item.text), ctx.app),
			);

			margin.dataset.editing = "false";
		}

		if (isMargin && ctx.settings.marginNoteDisplay === "popup") {
			ctx.setupMarginNotePopup(
				wrapper,
				margin,
				item.rawText ?? item.text,
				false,
				item.footnoteId,
			);
		}

		// Positioned properly only in the deferred pass below; suppress
		// the transition until then so it doesn't slide into place.
		margin.classList.add("is-placing");

		item.el.parentNode?.insertBefore(wrapper, item.el);
		wrapper.appendChild(item.el);
		wrapper.appendChild(margin);

		applyLineOffset(wrapper, margin, false);

		ctx.observeSidenoteVisibility(margin);
	}
}

/**
 * Margin notes render in the margin, so their entries in the endnote list
 * at the bottom of the note would be a duplicate. Hide them.
 */
export function hideMarginNoteFootnoteEntries(
	readingRoot: HTMLElement,
	allItems: ReadingItem[],
	sourceRefOrder: string[],
) {
	// Hide margin note entries from the footnotes section
	const footnotesSection = readingRoot.querySelector(
		"section.footnotes ol",
	);
	if (footnotesSection) {
		for (const item of allItems) {
			if (item.footnoteId && isMarginNote(item.footnoteId)) {
				const renderedIndex = sourceRefOrder.indexOf(item.footnoteId);
				if (renderedIndex >= 0) {
					const li = footnotesSection.children[
						renderedIndex
					] as HTMLElement | null;
					if (li) {
						li.classList.add("sidenote-footnote-item-hidden");
					}
				}
			}
		}
	}
}

/**
 * Clone content from a sidenote span to a margin element,
 * preserving links and other HTML elements.
 * Also sets up click handlers for internal Obsidian links.
 */
function cloneContentToMargin(
	app: App,
	source: HTMLElement,
	target: HTMLElement,
) {
	for (const child of Array.from(source.childNodes)) {
		const cloned = child.cloneNode(true);

		if (cloned.instanceOf(HTMLAnchorElement)) {
			setupLink(app, cloned);
		}

		if (cloned.instanceOf(HTMLElement)) {
			const links = cloned.querySelectorAll("a");
			links.forEach((link) => setupLink(app, link));
		}

		target.appendChild(cloned);
	}
}

/**
 * Set up a link element with proper attributes and click handlers.
 * Handles both external links and internal Obsidian links.
 */
function setupLink(app: App, link: HTMLAnchorElement) {
	// Check if it's an internal Obsidian link
	const isInternalLink =
		link.classList.contains("internal-link") ||
		link.hasAttribute("data-href") ||
		(link.href &&
			!link.href.startsWith("http://") &&
			!link.href.startsWith("https://") &&
			!link.href.startsWith("mailto:"));

	if (isInternalLink) {
		// Get the target from data-href (Obsidian's way) or href
		const target =
			link.getAttribute("data-href") || link.getAttribute("href") || "";

		// Ensure it has the internal-link class
		link.classList.add("internal-link");

		// Set data-href if not present
		if (!link.hasAttribute("data-href") && target) {
			link.setAttribute("data-href", target);
		}

		// Add click handler for internal navigation
		link.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();

			const linkTarget =
				link.getAttribute("data-href") || link.getAttribute("href") || "";
			if (linkTarget) {
				void app.workspace.openLinkText(linkTarget, "", false);
			}
		});

		// Don't open in new tab
		link.removeAttribute("target");
	} else {
		// External link - add external-link class for the icon
		link.classList.add("external-link");
		link.rel = "noopener noreferrer";
		link.target = "_blank";
	}
}

function findPrecedingHeading(el: HTMLElement): HTMLElement | null {
	let current: Element | null = el;
	while (current) {
		let sibling = current.previousElementSibling;
		while (sibling) {
			if (/^H[1-6]$/.test(sibling.tagName)) {
				return sibling as HTMLElement;
			}
			const heading = sibling.querySelector("h1, h2, h3, h4, h5, h6");
			if (heading) {
				return heading as HTMLElement;
			}
			sibling = sibling.previousElementSibling;
		}
		current = current.parentElement;
	}
	return null;
}

function getHeadingId(heading: HTMLElement): string {
	return (
		heading.textContent?.trim() || heading.id || Math.random().toString()
	);
}
