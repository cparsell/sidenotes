import type { App, MarkdownView } from "obsidian";
import type { SidenoteSettings } from "./settings";
import {
	buildSourceRefOrder,
	formatNumber,
	isMarginNote,
	normalizeText,
	parseFootnoteDefinitions,
	parseFootnoteIdString,
	renderLinksToFragment,
	resolveFootnoteBaseId,
} from "./content";

/**
 * Everything print export needs from the plugin's live state. Built fresh
 * from `this` at the single call site in main.ts.
 */
export interface PrintExportContext {
	app: App;
	settings: SidenoteSettings;
	fileContentCache: Map<string, string>;
	cachedSourceContent: string;
	getMarkdownView(): MarkdownView | null;
}

/**
 * Inject print sidenotes into a post-processed element.
 * Runs synchronously so the elements exist before Obsidian
 * captures the DOM for PDF export.
 */
export function injectPrintSidenotes(
	ctx: PrintExportContext,
	element: HTMLElement,
	context?: { sourcePath?: string },
) {
	// Only inject print sidenotes when rendering for PDF export.
	// Check if the element is inside a .print container.
	const printContainer =
		element.closest?.(".print") ?? element.parentElement?.closest?.(".print");
	if (!printContainer || !ctx.settings.pdfExport) return;

	if (element.querySelector(".sidenote-print")) return;

	const position = ctx.settings.sidenotePosition;
	const isRight = position !== "left";

	if (ctx.settings.sidenoteFormat === "html") {
		const spans = element.querySelectorAll<HTMLElement>("span.sidenote");
		if (spans.length === 0) return;

		const sidenotesByAnchor = new Map<HTMLElement, HTMLElement[]>();
		let counter = 0;

		for (const span of Array.from(spans)) {
			const text = span.textContent ?? "";
			if (!text.trim()) {
				// Nothing to move to the margin, but the span must not
				// contribute to the body text either.
				hideForPrint(span);
				continue;
			}

			// Without an anchor the note has nowhere to go in the margin
			// column, so leave the span alone rather than dropping its
			// content from the export.
			const anchor = span.closest(
				"p, li, h1, h2, h3, h4, h5, h6",
			) as HTMLElement | null;
			if (!anchor) continue;

			const isMargin = isMarginNote(span);
			if (!isMargin) {
				counter++;
			}

			const numStr = isMargin ? "" : formatNumber(counter, ctx.settings.numberStyle);

			if (!isMargin) {
				const refNum = document.createElement("sup");
				refNum.className = "sidenote-print-refnum-html";
				refNum.textContent = numStr;
				span.parentNode?.insertBefore(refNum, span.nextSibling);
			}

			// Reading-mode processing only runs on .markdown-reading-view,
			// so the raw span is never turned into a margin note inside
			// the print container — it would render as inline body text.
			// Its content is reproduced in the sidenote column instead.
			hideForPrint(span);

			const printEl = buildPrintSidenote(ctx, text, numStr);
			if (isMargin) {
				printEl.classList.add("margin-note");
			}

			const list = sidenotesByAnchor.get(anchor) ?? [];
			list.push(printEl);
			sidenotesByAnchor.set(anchor, list);
		}

		buildPrintTables(element, sidenotesByAnchor, isRight);
		return;
	}

	// Footnote format — definitions come from the source markdown when it
	// is available (it keeps the original [^label] IDs and markdown links)
	// and from the rendered endnote list otherwise.
	const content = getPrintSourceContent(ctx, context?.sourcePath ?? "");
	const definitions = parseFootnoteDefinitions(content);
	const sourceRefOrder = buildSourceRefOrder(content);

	const printRoot = (printContainer as HTMLElement | null) ?? element;
	const renderedDefinitions = parseFootnoteDefinitionsFromDom(printRoot);

	// Margin notes live in the margin only, so drop them from the
	// endnote list the same way reading mode does.
	prunePrintEndnotes(ctx.settings, printRoot, sourceRefOrder);

	if (definitions.size === 0 && renderedDefinitions.size === 0) return;

	const refs = element.querySelectorAll<HTMLElement>(
		"sup.footnote-ref, sup[class*='footnote'], sup[id^='fnref-'], sup[data-footnote-id], a.footnote-link",
	);
	if (refs.length === 0) return;

	const sidenotesByAnchor = new Map<HTMLElement, HTMLElement[]>();
	const processedIds = new Set<string>();

	for (const ref of Array.from(refs)) {
		// Links inside the endnote list are backrefs, not references
		if (ref.closest("section.footnotes, .footnotes")) continue;

		const renderedId = resolveFootnoteBaseId(ref);
		if (!renderedId) continue;

		// Obsidian renumbers footnotes sequentially when rendering, so
		// map "1" back to the source label (e.g. [^mn-2]) before looking
		// the definition up.
		let id = renderedId;
		const renderedNum = parseInt(renderedId, 10);
		if (
			!isNaN(renderedNum) &&
			renderedNum >= 1 &&
			renderedNum <= sourceRefOrder.length
		) {
			const sourceId = sourceRefOrder[renderedNum - 1];
			if (sourceId && definitions.has(sourceId)) {
				id = sourceId;
			}
		}

		if (processedIds.has(renderedId) || processedIds.has(id)) continue;
		processedIds.add(renderedId);
		processedIds.add(id);

		const text = definitions.get(id) ?? renderedDefinitions.get(renderedId);
		if (!text) continue;

		const refTarget =
			ref.tagName === "SUP" ? ref : (ref.closest("sup") ?? ref);
		const anchor = refTarget.closest<HTMLElement>(
			"p, li, h1, h2, h3, h4, h5, h6",
		);
		// Without an anchor there is no margin column to move the note
		// into, so leave the reference untouched.
		if (!anchor) continue;

		const isMargin = isMarginNote(id);
		// Reading mode labels a footnote with its own source ID, so the
		// export matches what the note looks like on screen.
		const numStr = isMargin ? "" : id;

		if (ctx.settings.hideFootnoteNumbers) {
			const link = ref.tagName === "A" ? ref : refTarget.querySelector("a");
			if (link instanceof HTMLElement) {
				link.classList.add("sidenote-fn-link-hidden");
			}
		}

		if (!isMargin) {
			const refNum = document.createElement("sup");
			refNum.className = "sidenote-print-refnum-footnote";
			refNum.textContent = numStr;
			refTarget.parentNode?.insertBefore(refNum, refTarget.nextSibling);
		}

		const printEl = buildPrintSidenote(ctx, text, numStr);
		if (isMargin) {
			printEl.classList.add("margin-note");
		}

		const list = sidenotesByAnchor.get(anchor) ?? [];
		list.push(printEl);
		sidenotesByAnchor.set(anchor, list);
	}

	buildPrintTables(element, sidenotesByAnchor, isRight);
}

/**
 * Source markdown for the file being exported. Prefers the pre-cached
 * copy for that exact path so exporting a note other than the active
 * one doesn't pick up the active note's footnotes.
 */
function getPrintSourceContent(
	ctx: PrintExportContext,
	sourcePath: string,
): string {
	if (sourcePath) {
		const cached = ctx.fileContentCache.get(sourcePath);
		if (cached) return cached;
	}

	const view = ctx.getMarkdownView();
	if (sourcePath && view?.file?.path !== sourcePath) return "";

	return (
		view?.editor?.getValue() ||
		(view as { data?: string })?.data ||
		ctx.cachedSourceContent ||
		""
	);
}

/**
 * Fallback definitions read from the rendered endnote list, keyed by the
 * rendered footnote number. Used when the source markdown isn't
 * available synchronously during export.
 */
function parseFootnoteDefinitionsFromDom(
	root: HTMLElement,
): Map<string, string> {
	const definitions = new Map<string, string>();
	const items = root.querySelectorAll<HTMLElement>(
		"section.footnotes li[id^='fn-'], .footnotes li[id^='fn-']",
	);

	for (const li of Array.from(items)) {
		const id = parseFootnoteIdString(li.id, "fn");
		if (!id) continue;

		const clone = li.cloneNode(true) as HTMLElement;
		clone.querySelectorAll(".footnote-backref").forEach((el) => el.remove());
		const text = normalizeText(clone.textContent ?? "");
		if (text) definitions.set(id, text);
	}

	return definitions;
}

/**
 * Trim the endnote list for export: the whole thing when "Hide
 * footnotes" is on, otherwise just the margin notes ([^mn-...]), whose
 * text is already shown in the margin. Mirrors reading-mode behaviour.
 */
function prunePrintEndnotes(
	settings: SidenoteSettings,
	root: HTMLElement,
	sourceRefOrder: string[],
) {
	if (settings.hideFootnotes) {
		root
			.querySelectorAll<HTMLElement>("section.footnotes, .footnotes")
			.forEach((section) => hideForPrint(section));
		return;
	}

	if (sourceRefOrder.length === 0) return;

	const list = root.querySelector<HTMLElement>(
		"section.footnotes ol, .footnotes ol",
	);
	if (!list) return;

	const items = Array.from(list.children) as HTMLElement[];
	let hidden = 0;

	items.forEach((li, index) => {
		const id = sourceRefOrder[index];
		if (id && isMarginNote(id)) {
			hideForPrint(li);
			hidden++;
		}
	});

	// An endnote list of nothing but margin notes leaves an empty
	// heading and rule behind — drop the whole section instead.
	if (hidden > 0 && hidden === items.length) {
		const section = list.closest("section.footnotes, .footnotes");
		if (section instanceof HTMLElement) {
			hideForPrint(section);
		}
	}
}

/**
 * Shared logic: wrap anchor paragraphs in table layouts and
 * inject the max-width style constraint.
 */
function buildPrintTables(
	element: HTMLElement,
	sidenotesByAnchor: Map<HTMLElement, HTMLElement[]>,
	isRight: boolean,
) {
	if (sidenotesByAnchor.size === 0) return;

	for (const [anchor, sidenotes] of sidenotesByAnchor) {
		if (!anchor.parentNode) continue;

		const table = document.createElement("table");
		table.className = "sidenote-print-table";

		const row = document.createElement("tr");
		row.className = "sidenote-print-row";

		const contentCell = document.createElement("td");
		contentCell.className = "sidenote-print-content-cell";

		const sidenoteCell = document.createElement("td");
		sidenoteCell.className = "sidenote-print-sidenote-cell";
		if (!isRight) {
			sidenoteCell.classList.add("is-left");
		}

		anchor.parentNode.insertBefore(table, anchor);
		contentCell.appendChild(anchor);

		for (const sn of sidenotes) {
			if (sidenoteCell.childNodes.length > 0) {
				const spacer = document.createElement("div");
				spacer.className = "sidenote-print-spacer";
				sidenoteCell.appendChild(spacer);
			}
			sidenoteCell.appendChild(sn);
		}

		if (isRight) {
			row.appendChild(contentCell);
			row.appendChild(sidenoteCell);
		} else {
			row.appendChild(sidenoteCell);
			row.appendChild(contentCell);
		}

		table.appendChild(row);
	}

	// Width-constraining rules live in styles.css, scoped to this class;
	// applying it here just switches them on for this export container.
	element.classList.add("sidenote-print-page");
	if (!isRight) {
		element.classList.add("sidenote-print-page--left");
	}
}

/**
 * Hide an element in the PDF export DOM. The class carries
 * `display: none !important`, so nothing in the exported document can
 * bring the element back.
 */
function hideForPrint(el: HTMLElement) {
	el.classList.add("sidenote-print-hidden");
}

function buildPrintSidenote(
	ctx: PrintExportContext,
	text: string,
	numStr: string,
): HTMLElement {
	const printEl = document.createElement("small");
	printEl.className = "sidenote-print";

	if (ctx.settings.showSidenoteNumbers && numStr) {
		const numSpan = document.createElement("span");
		numSpan.className = "sidenote-print-number";
		numSpan.textContent = numStr + ".";
		printEl.appendChild(numSpan);
	}

	printEl.appendChild(renderLinksToFragment(normalizeText(text), ctx.app));

	return printEl;
}
