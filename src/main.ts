import { MarkdownView, Plugin, TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import {
	DEFAULT_SETTINGS,
	SidenoteSettings,
	SidenoteSettingTab,
} from "./settings";

import { applyCssVariables, clearCssVariables } from "./css-vars";
import {
	SIDENOTE_CLASS_CAPTURE_REGEX,
	SIDENOTE_PATTERN,
	SIDENOTE_SPAN_REGEX,
} from "./patterns";
import {
	type EditingModeContext,
	buildEditingHtmlSidenotes,
	positionEditingSidenotes,
} from "./editing-mode";
import {
	type ReadingModeContext,
	buildReadingMargins,
	collectReadingItems,
	hideMarginNoteFootnoteEntries,
	positionReadingSidenotes,
} from "./reading-mode";
import type { SidenoteWidgetHost } from "./widget-host";
import { registerSidenoteCommands } from "./commands";
import {
	applyRootMetrics,
	calculateMode,
	clearRootMetrics,
} from "./layout-math";
import {
	getSidenoteSideOverride,
	normalizeText,
	parseFootnoteDefinitions,
	renderLinksToFragment,
	type SidenoteSide,
} from "./content";
import {
	updateAllCollisions,
	updateCollisionsIn,
} from "./collision-runner";
import { LayoutScheduler, TIMING } from "./scheduling";
import {
	injectPrintSidenotes,
	type PrintExportContext,
} from "./print-export";
import { createFootnoteSidenotePlugin } from "./widgets";
import {
	type InlineEditorHandle,
	openInlineMarkdownEditor,
} from "./inline-editor";

type CleanupFn = () => void;

/** A margin element carrying the teardown for whatever was mounted inside it. */
interface SidenoteMarginElement extends HTMLElement {
	_sidenoteCleanup?: () => void;
}

/**
 * Popup-mode margin notes append their popup to document.body and register a
 * document-level click listener, so removing the wrapper is not enough to
 * clean them up — the teardown has to be invoked explicitly.
 */
interface SidenoteWrapperElement extends HTMLElement {
	_popupCleanup?: () => void;
}

// ======================================================
// ================= Main Plugin Class ==================
// ======================================================
export default class SidenotePlugin
	extends Plugin
	implements SidenoteWidgetHost, ReadingModeContext, EditingModeContext
{
	settings: SidenoteSettings;

	private cleanups: CleanupFn[] = [];
	private cmRoot: HTMLElement | null = null;

	/** Owns every rAF handle, timer and margin observer. */
	private readonly scheduler = new LayoutScheduler({
		layout: () => this.layout(),
		readingModeLayout: () => this.scheduleReadingModeLayout(),
		collisions: () =>
			updateAllCollisions(this.settings, {
				cmRoot: this.cmRoot,
				readingRoot: this.getReadingRoot(),
			}),
	});

	public isMutating = false;
	private resizeObserver: ResizeObserver | null = null;

	public headingSidenoteNumbers: Map<string, number> = new Map();

	// Incremented on every settings save to signal the CM6 ViewPlugin to rebuild
	private _settingsVersion = 0;

	// Track whether current document has any sidenotes
	public documentHasSidenotes = false;

	// Which margins the document's sidenotes actually occupy, derived from the
	// SOURCE text rather than from mounted DOM. Both CM6 and reading mode
	// virtualise content, so a DOM query only ever sees the notes near the
	// viewport — reserving margin space off that would make the page offset
	// (and therefore the body text) shift around as you scroll.
	public documentSidenoteSides: Record<SidenoteSide, boolean> = {
		left: false,
		right: false,
	};

	// Performance: Debounce/throttle timers

	// Performance: Layout caching
	public lastSidenoteCount: number = 0;

	// Performance: Visible sidenotes tracking

	private isEditingMargin = false;

	public needsReadingModeRefresh = true;

	private pendingFootnoteEdit: string | null = null;
	private pendingFootnoteEditRetries = 0;

	// Cached source content for reading mode (editor.getValue() can be empty)
	private cachedSourceContent: string = "";
	/**
	 * Which file `cachedSourceContent` was read from.
	 *
	 * The cache is a single string, so without this it silently serves the
	 * previously-open note's source to whichever file is active now. That
	 * decided `documentHasSidenotes`, and therefore whether the page offset
	 * reserving margin space applied — so a note would or would not shift
	 * depending on what you had open before it.
	 */
	private cachedSourcePath: string | null = null;

	private static readonly MAX_FOOTNOTE_EDIT_RETRIES = 10;

	/**
	 * The open editing-mode margin editor, if any — also the "already open"
	 * guard. Replaces a three-field triple (view, original text, outside-click
	 * listener) that had to be kept in sync by hand.
	 */
	private spanEditor: InlineEditorHandle | null = null;

	// Pre-cached file content for PDF export (keyed by file path)
	private fileContentCache = new Map<string, string>();

	// Track which footnote is being edited (by footnote ID)
	private activeFootnoteEdit: string | null = null;

	// Collision avoidance scheduling. Kept separate from `rafId` (used by
	// scheduleLayout) so a pending layout never swallows a collision request.
	// Watches every margin for height changes (late image/embed loads, inline
	// editor open/close, font swaps) and re-resolves collisions.

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new SidenoteSettingTab(this.app, this));
		applyCssVariables(this.settings);

		// Register the CM6 extension for footnote sidenotes in editing mode
		this.registerEditorExtension([createFootnoteSidenotePlugin(this)]);

		registerSidenoteCommands(this, {
			settings: this.settings,
			requestFootnoteEdit: (id) => this.queueFootnoteEdit(id),
			getCmRoot: () => this.cmRoot,
			setMutating: (v) => {
				this.isMutating = v;
			},
		});

		this.registerMarkdownPostProcessor((element, context) => {
			let hasContent = false;

			if (this.settings.sidenoteFormat === "html") {
				hasContent = element.querySelectorAll("span.sidenote").length > 0;
			} else {
				hasContent =
					element.querySelectorAll(
						"sup.footnote-ref, sup[id^='fnref-'], sup[data-footnote-id], a.footnote-link, section.footnotes",
					).length > 0;
			}

			if (hasContent) {
				if (this.settings.sidenoteFormat !== "html") {
					this.scheduleFootnoteProcessing();
				} else {
					window.setTimeout(() => {
						window.requestAnimationFrame(() => {
							window.requestAnimationFrame(() => {
								this.processReadingModeSidenotes(element);
							});
						});
					}, 0);
				}

				// Inject print sidenotes synchronously for PDF export
				injectPrintSidenotes(this.printExportContext(), element, context);
			}
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.resetRegistry();
				this.invalidateLayoutCache();
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.rebind();
				this.scheduler.scheduleLayoutStable();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				// Update cached source so reading mode picks up edits
				// made in editing mode (and vice versa)
				this.scanDocumentForSidenotes();
				this.needsReadingModeRefresh = true;
				this.invalidateLayoutCache();
				this.rebindAndSchedule();
				void this.preCacheFileContent();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (_file: TFile | null) => {
				this.resetRegistry();
				this.invalidateLayoutCache();
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.rebindAndSchedule();
				void this.preCacheFileContent();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				if (this.isEditingMargin) return;
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.invalidateLayoutCache();
				this.scheduler.scheduleLayoutDebounced();
				void this.preCacheFileContent();
			}),
		);

		this.registerDomEvent(window, "resize", () => {
			this.needsReadingModeRefresh = true;
			this.scheduler.scheduleLayoutThrottled();
			this.scheduler.scheduleReadingLayoutThrottled(100);
		});

		// Immediate — works if plugin is enabled/reloaded after startup
		// this.scanDocumentForSidenotes();
		// this.rebindAndSchedule();
		// void this.preCacheFileContent();

		this.app.workspace.onLayoutReady(() => {
			this.scanDocumentForSidenotes();
			this.rebindAndSchedule();
			void this.preCacheFileContent();

			// Debug: log what state we're in
			// setTimeout(() => {
			// 	const cmRoot = this.cmRoot;
			// 	console.log("[Sidenotes] Startup check:", {
			// 		hasCmRoot: !!cmRoot,
			// 		cmRootConnected: cmRoot?.isConnected,
			// 		cmRootWidth: cmRoot?.getBoundingClientRect().width,
			// 		mode: cmRoot?.dataset.sidenoteMode,
			// 		hasSidenotes: cmRoot?.dataset.hasSidenotes,
			// 		marginCount: cmRoot?.querySelectorAll("small.sidenote-margin")
			// 			.length,
			// 		resizeObserverExists: !!this.resizeObserver,
			// 	});
			// }, 2000);
		});
	}

	onunload() {
		this.scheduler.dispose();
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		// Clear pending edit
		this.pendingFootnoteEdit = null;
		this.pendingFootnoteEditRetries = 0;

		// Clear active footnote edit
		this.activeFootnoteEdit = null;

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		const view = this.getMarkdownView();
		this.cleanupView(view);

		// Remove CSS custom properties and data attributes
		clearCssVariables();
	}

	public setActiveFootnoteEdit(footnoteId: string | null) {
		this.activeFootnoteEdit = footnoteId;
	}

	public isFootnoteBeingEdited(): boolean {
		return this.activeFootnoteEdit !== null;
	}

	public get settingsVersion(): number {
		return this._settingsVersion;
	}

	/**
	 * Snapshot of the state `injectPrintSidenotes` (src/print-export.ts)
	 * needs, built fresh on every post-processor pass.
	 */
	private printExportContext(): PrintExportContext {
		return {
			app: this.app,
			settings: this.settings,
			fileContentCache: this.fileContentCache,
			getActiveSourceText: () => this.getSourceText(),
			getMarkdownView: () => this.getMarkdownView(),
		};
	}

	/**
	 * Run and clear a wrapper's popup teardown, if it has one. Popup-mode
	 * margin notes live on document.body with a document-level click listener,
	 * so they outlive their wrapper unless this is called.
	 */
	private runPopupCleanup(wrapper: Element) {
		const snWrapper = wrapper as SidenoteWrapperElement;
		if (!snWrapper._popupCleanup) return;
		// cleanupView() runs from onunload, so a throw here would abort the
		// rest of the teardown and leave observers and listeners attached.
		try {
			snWrapper._popupCleanup();
		} catch (error) {
			console.error("Sidenote plugin: popup cleanup failed", error);
		}
		delete snWrapper._popupCleanup;
	}

	private cleanupView(view: MarkdownView | null) {
		if (!view) return;

		const cmRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (cmRoot) {
			cmRoot
				.querySelectorAll("span.sidenote-number")
				.forEach((wrapper) => {
					this.runPopupCleanup(wrapper);
					const parent = wrapper.parentNode;
					if (!parent) return;
					// Move the original span.sidenote back before the wrapper
					const sidenote = wrapper.querySelector("span.sidenote");
					if (sidenote) {
						parent.insertBefore(sidenote, wrapper);
					}
					// Now safe to remove the wrapper (only contains the margin)
					wrapper.remove();
				});
			cmRoot
				.querySelectorAll("small.sidenote-margin")
				.forEach((n) => n.remove());
			clearRootMetrics(cmRoot);
		}

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			readingRoot.querySelectorAll("span.sidenote-number").forEach((n) => {
				this.runPopupCleanup(n);
				n.remove();
			});
			readingRoot
				.querySelectorAll("small.sidenote-margin")
				.forEach((n) => n.remove());
			clearRootMetrics(readingRoot);

			// Clear processed flags
			readingRoot
				.querySelectorAll("[data-sidenotes-processed]")
				.forEach((el) => {
					delete (el as HTMLElement).dataset.sidenotesProcessed;
				});
		}

		// Clean up margin note popups appended to document.body
		document
			.querySelectorAll(".margin-note-popup")
			.forEach((el) => el.remove());
	}

	async loadSettings() {
		try {
			const data = (await this.loadData()) as
				| Partial<SidenoteSettings>
				| undefined;
			this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		} catch (error) {
			console.error("Sidenote plugin: Failed to load settings", error);
			this.settings = Object.assign({}, DEFAULT_SETTINGS);
		}
	}

	async saveSettings() {
		try {
			// Validate settings before saving
			const s = this.settings;

			// Ensure min <= max for widths
			if (s.minSidenoteWidth > s.maxSidenoteWidth) {
				s.minSidenoteWidth = s.maxSidenoteWidth;
			}

			// Ensure breakpoints are in order
			if (s.hideBelow >= s.compactBelow) {
				s.compactBelow = s.hideBelow + 100;
			}
			if (s.compactBelow >= s.fullAbove) {
				s.fullAbove = s.compactBelow + 100;
			}

			// Clamp values to reasonable ranges
			s.collisionSpacing = Math.max(0, Math.min(50, s.collisionSpacing));
			s.fontSize = Math.max(50, Math.min(150, s.fontSize));
			s.fontSizeCompact = Math.max(50, Math.min(150, s.fontSizeCompact));
			s.lineHeight = Math.max(1, Math.min(3, s.lineHeight));
			s.pageOffsetFactor = Math.max(0, Math.min(1, s.pageOffsetFactor));

			await this.saveData(this.settings);

			// Bump the settings version so the CM6 ViewPlugin rebuilds
			this._settingsVersion++;

			// Apply new CSS variables
			applyCssVariables(this.settings);

			// Reset numbering state
			this.resetRegistry();
			this.invalidateLayoutCache();
			this.scanDocumentForSidenotes();

			// --- Reading mode: full teardown + rebuild ---
			this.cleanupReadingMode();
			this.needsReadingModeRefresh = true;
			this.forceReadingModeRefresh();

			// --- Editing mode: let CM6 handle it ---
			// Don't manually remove DOM inside .cm-content — that corrupts
			// CM6's internal state. Instead, force CM6 to re-render.
			const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
			const cmEditor = (mdView?.editor as { cm?: EditorView })?.cm;
			if (cmEditor) {
				// requestMeasure triggers a geometry pass, which causes
				// the ViewPlugin's update() to fire and see the bumped
				// settingsVersion, rebuilding all decorations.
				cmEditor.requestMeasure();
			}

			// Re-bind scroll/resize/mutation observers and schedule layout
			this.rebindAndSchedule();
		} catch (error) {
			console.error("Sidenote plugin: Failed to save settings", error);
		}
	}

	/**
	 * Pre-cache the current file's content so it's available
	 * synchronously during PDF export post-processing.
	 */
	private async preCacheFileContent() {
		const view = this.getMarkdownView();
		const file = view?.file ?? this.app.workspace.getActiveFile();
		if (!file) return;

		const content = await this.app.vault.cachedRead(file);
		if (content) {
			this.fileContentCache.set(file.path, content);
		}
	}

	public getMarkdownView(): MarkdownView | null {
		// Try active view first
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active;

		// Fallback: find any visible markdown leaf
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			if (leaf.view instanceof MarkdownView) {
				return leaf.view;
			}
		}
		return null;
	}

	/**
	 * Clean up sidenote markup from reading mode only.
	 * Never manually remove DOM inside CM6 .cm-content — that
	 * corrupts CM6's internal state and causes sidenotes to vanish.
	 */
	private cleanupReadingMode() {
		const view = this.getMarkdownView();
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			this.removeAllSidenoteMarkupFromReadingMode(readingRoot);
			readingRoot.dataset.sidenoteMode = "";
			readingRoot.dataset.hasSidenotes = "";
		}
	}

	/**
	 * Queue a freshly-inserted footnote so its margin editor opens once the
	 * CM6 widget for it has mounted.
	 */
	private queueFootnoteEdit(footnoteId: string) {
		this.pendingFootnoteEdit = footnoteId;
		window.setTimeout(() => {
			this.triggerPendingFootnoteEdit();
		}, TIMING.INSERT_SIDENOTE_DELAY);
	}

	/**
	 * Force a refresh of reading mode sidenotes.
	 */
	private forceReadingModeRefresh() {
		this.needsReadingModeRefresh = true;
		const view = this.getMarkdownView();
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (!readingRoot) return;

		// Clear any processed flags
		readingRoot
			.querySelectorAll("[data-sidenotes-processed]")
			.forEach((el) => {
				delete (el as HTMLElement).dataset.sidenotesProcessed;
			});

		// Reset the mode so it gets recalculated.
		//
		// Deliberately NOT clearRootMetrics(): that also clears hasSidenotes
		// and the position/opposite flags, which drive the page offset. Wiping
		// them here would drop the reserved margin space for a frame and make
		// the body text jump sideways before the reprocess restores it.
		readingRoot.dataset.sidenoteMode = "";
		readingRoot.style.removeProperty("--sidenote-scale");

		// Schedule reprocessing with a delay to ensure cleanup is complete
		window.setTimeout(() => {
			const useFootnotes =
				this.settings.sidenoteFormat === "footnote" ||
				this.settings.sidenoteFormat === "footnote-edit";

			if (useFootnotes) {
				// Wait until footnote defs are present, then process.
				this.scheduleFootnoteProcessing();
				return;
			}

			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => {
					this.processReadingModeSidenotes(readingRoot);
				});
			});
		}, TIMING.FOOTNOTE_RENDER_DELAY);
	}

	private triggerPendingFootnoteEdit() {
		if (!this.pendingFootnoteEdit) return;

		const footnoteId = this.pendingFootnoteEdit;
		this.pendingFootnoteEdit = null;

		const cmRoot = this.cmRoot;
		if (!cmRoot) return;

		// Find the wrapper for this footnote by its ID
		const wrapper = cmRoot.querySelector<HTMLElement>(
			`span.sidenote-number[data-footnote-id="${footnoteId}"]`,
		);

		if (!wrapper) {
			// Widget might not be rendered yet, try again (with limit)
			if (
				this.pendingFootnoteEditRetries <
				SidenotePlugin.MAX_FOOTNOTE_EDIT_RETRIES
			) {
				this.pendingFootnoteEdit = footnoteId;
				this.pendingFootnoteEditRetries++;
				window.setTimeout(() => {
					this.triggerPendingFootnoteEdit();
				}, TIMING.FOOTNOTE_RENDER_DELAY);
			} else {
				// Give up after max retries
				this.pendingFootnoteEditRetries = 0;
			}
			return;
		}

		// Find the margin inside the wrapper
		const margin = wrapper.querySelector<HTMLElement>(
			"small.sidenote-margin",
		);
		if (!margin) return;

		// Tell the CM6 editor (mounted by FootnoteSidenoteWidget.startMarginEdit)
		// to select all its text as soon as it opens, so the placeholder
		// content is easy to type over.
		margin.dataset.selectAllOnOpen = "true";

		// Simulate a click to start editing
		margin.click();
	}

	// ==================== Performance Utilities ====================

	private invalidateLayoutCache() {
		this.lastSidenoteCount = 0;
	}

	public observeSidenoteVisibility(margin: HTMLElement) {
		this.scheduler.observeMargin(margin);
	}

	public unobserveSidenoteVisibility(margin: HTMLElement) {
		this.scheduler.unobserveMargin(margin);
	}

	private findHtmlSidenoteInSource(sidenoteText: string): {
		text: string;
		fullMatch: string;
		index: number;
		openingTag: string;
	} | null {
		const content = this.getSourceText();
		if (!content) return null;

		const regex = SIDENOTE_SPAN_REGEX();
		let match: RegExpExecArray | null;

		// Try exact match first
		while ((match = regex.exec(content)) !== null) {
			if ((match[1] ?? "") === sidenoteText) {
				return {
					text: match[1] ?? "",
					fullMatch: match[0],
					index: match.index,
					openingTag: match[0].substring(0, match[0].indexOf(">") + 1),
				};
			}
		}

		// Fallback: try normalized match
		const normalized = this.normalizeText(sidenoteText);
		const regex2 = SIDENOTE_SPAN_REGEX();
		while ((match = regex2.exec(content)) !== null) {
			if (this.normalizeText(match[1] ?? "") === normalized) {
				return {
					text: match[1] ?? "",
					fullMatch: match[0],
					index: match.index,
					openingTag: match[0].substring(0, match[0].indexOf(">") + 1),
				};
			}
		}
		return null;
	}

	// ==================== Reading Mode Processing ====================

	private processReadingModeSidenotes(element: HTMLElement) {
		const view = this.getMarkdownView();
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (!readingRoot) return;

		// Check if there are footnote refs or sidenote spans not yet wrapped
		const unwrappedFootnotes = readingRoot.querySelectorAll(
			"sup.footnote-ref:not(.sidenote-number sup), sup[id^='fnref-']:not(.sidenote-number sup), sup[data-footnote-id]:not(.sidenote-number sup)",
		);
		const unwrappedSpans = readingRoot.querySelectorAll(
			"span.sidenote:not(.sidenote-number span.sidenote)",
		);
		const hasUnwrapped =
			unwrappedFootnotes.length > 0 || unwrappedSpans.length > 0;

		const hasAnyMargins =
			readingRoot.querySelector("small.sidenote-margin") !== null;

		// If nothing new to wrap and no full refresh needed, still recompute positioning.
		// This is required when settings like sidenoteAnchor / sidenotePosition change.
		if (!this.needsReadingModeRefresh && !hasUnwrapped) {
			if (hasAnyMargins) {
				window.requestAnimationFrame(() =>
					positionReadingSidenotes(this, readingRoot, {
						recomputeLineOffsets: false,
					}),
				);
			}
			return;
		}

		const isFullRefresh = this.needsReadingModeRefresh;

		const width = readingRoot.getBoundingClientRect().width;
		const mode = applyRootMetrics(this.settings, readingRoot, width);

		if (mode === "hidden") {
			return;
		}

		// Only do full teardown on explicit refresh (file change, settings change).
		// For incremental processing (new sections scrolled into view), keep
		// existing sidenotes and only wrap the new unwrapped refs.
		if (isFullRefresh) {
			this.removeAllSidenoteMarkupFromReadingMode(readingRoot);
			// Everything is about to be renumbered from scratch, so the
			// per-heading counters have to start over too. Without this they
			// carry over from the previous pass and every re-render pushes the
			// numbering higher — 1,2,3 becomes 21,22,23 becomes 61,62,63.
			// Incremental passes deliberately keep the counters, since they
			// only number the newly-mounted sections.
			this.headingSidenoteNumbers.clear();
		}

		const collected = collectReadingItems(this, readingRoot);
		if (!collected) return;
		const {
			items: allItems,
			sourceRefOrder,
			htmlNumberByIndex,
		} = collected;

		// console.log(
		// 	"[Sidenotes] allItems:",
		// 	allItems.length,
		// 	allItems.map((i) => i.footnoteId),
		// );

		// Drive the page-offset CSS from whether the *document* has sidenotes
		// (computed from source in scanDocumentForSidenotes), not from how many
		// sidenote elements happen to be mounted right now. Obsidian virtualizes
		// long reading views, so `allItems` here only reflects the currently
		// rendered section — using its length instead flipped the offset on and
		// off as the mounted sidenotes came in and out of the DOM while scrolling.
		readingRoot.dataset.hasSidenotes = this.documentHasSidenotes
			? "true"
			: "false";

		if (allItems.length === 0) {
			return;
		}

		this.needsReadingModeRefresh = false;

		// Sort by vertical position. Items with valid rects sort by top position;
		// items with zero rects (not yet laid out) sort by their DOM order,
		// which querySelectorAll already preserves.
		allItems.sort((a, b) => a.rect.top - b.rect.top);

		buildReadingMargins(this, allItems, htmlNumberByIndex);
		hideMarginNoteFootnoteEntries(readingRoot, allItems, sourceRefOrder);

		// Run positioning after DOM is fully settled and elements are laid out.
		// We defer twice: once to let the browser insert elements, once to lay
		// them out.
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() =>
				positionReadingSidenotes(this, readingRoot, {
					recomputeLineOffsets: true,
				}),
			);
		});
	}

	public scheduleFootnoteProcessing() {
		this.scheduler.scheduleFootnoteProcessing(() => {
			const view = this.getMarkdownView();
			if (!view) return;

			const readingRoot = view.containerEl.querySelector<HTMLElement>(
				".markdown-reading-view",
			);
			if (!readingRoot) {
				// console.log(
				// 	"[Sidenotes] scheduleFootnoteProcessing: no readingRoot found",
				// );
				return;
			}

			// Only require refs in DOM (defs may be virtualized away)
			const refElements = readingRoot.querySelectorAll(
				"sup.footnote-ref, sup[data-footnote-id], sup[id^='fnref-'], a.footnote-link",
			);
			const hasRefs = refElements.length > 0;

			if (hasRefs) {
				// Check if all refs are already wrapped — if so, skip
				const unwrappedRefs = Array.from(refElements).filter(
					(el) => !el.closest(".sidenote-number"),
				);
				if (unwrappedRefs.length === 0 && !this.needsReadingModeRefresh) {
					// Nothing new to wrap, but the DOM mutation that got us here
					// still changed the page: Obsidian virtualises preview
					// sections in and out, which adds/removes margins and moves
					// the anchors of the ones that remain. Skipping the restack
					// is what leaves sidenotes overlapping until an unrelated
					// event happens to trigger one.
					this.scheduler.scheduleCollisions();
					return;
				}

				window.requestAnimationFrame(() => {
					window.requestAnimationFrame(() => {
						this.processReadingModeSidenotes(readingRoot);
					});
				});
			}
		});
	}

	private removeAllSidenoteMarkupFromReadingMode(root: HTMLElement) {
		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
			this.runPopupCleanup(wrapper);

			// Find the original element inside
			const sidenoteSpan =
				wrapper.querySelector<HTMLElement>("span.sidenote");
			const footnoteSup = wrapper.querySelector<HTMLElement>(
				"sup.footnote-ref, sup[class*='footnote'], sup[data-footnote-id]",
			);

			const originalEl = sidenoteSpan ?? footnoteSup;

			// Restore footnote link visibility if needed
			if (footnoteSup) {
				const link = footnoteSup.querySelector<HTMLElement>("a");
				if (link) {
					link.classList.remove("sidenote-fn-link-hidden");
				}
			}

			// Clean up margin
			const margin = wrapper.querySelector<HTMLElement>(
				"small.sidenote-margin",
			);
			if (margin) {
				const snMargin = margin as SidenoteMarginElement;
				if (snMargin._sidenoteCleanup) {
					snMargin._sidenoteCleanup();
					delete snMargin._sidenoteCleanup;
				}
				this.unobserveSidenoteVisibility(margin);
				margin.remove();
			}

			// Unwrap original element
			if (originalEl && wrapper.parentNode) {
				wrapper.parentNode.insertBefore(originalEl, wrapper);
			}

			wrapper.remove();
		}
		// Also remove any print-only sidenote elements
		root.querySelectorAll(".sidenote-print").forEach((el) => el.remove());
		// …and un-hide anything print export hid
		root
			.querySelectorAll(".sidenote-print-hidden")
			.forEach((el) => el.classList.remove("sidenote-print-hidden"));
	}

	/**
	 * True when the active markdown view is showing rendered preview.
	 *
	 * This matters for every write-back path. In reading mode there is no live
	 * editor backing the view: `editor.replaceRange` writes into a CodeMirror
	 * document that Obsidian discards the moment you switch to editing mode, so
	 * the edit renders correctly and then silently disappears. Writes made in
	 * this mode have to go through `vault.process`, which touches the file.
	 */
	private isPreviewMode(): boolean {
		return this.getMarkdownView()?.getMode() === "preview";
	}

	/**
	 * The document's source markdown, resolved through every available
	 * fallback. This is the single place that ordering decision is made.
	 *
	 * The order depends on mode, and getting it wrong is subtle:
	 * `editor.getValue()` is authoritative while editing, but in preview the
	 * editor's document lags the file, because reading-mode commits go through
	 * `vault.process` and the editor never sees them. Preferring the editor
	 * there hands back pre-edit text — which is why a freshly-edited sidenote
	 * would reopen showing its old contents.
	 */
	/** Record the source text together with the file it came from. */
	public setCachedSource(content: string, path: string | null) {
		this.cachedSourceContent = content;
		this.cachedSourcePath = path;
	}

	/** Cached source, but only when it belongs to the active file. */
	private validCachedSource(): string {
		const path = this.getMarkdownView()?.file?.path;
		return path && path === this.cachedSourcePath
			? this.cachedSourceContent
			: "";
	}

	public getSourceText(): string {
		const view = this.getMarkdownView();
		const editorText = view?.editor?.getValue();
		const viewData = (view as { data?: string } | null)?.data;

		const cached = this.validCachedSource();

		return this.isPreviewMode()
			? viewData || cached || editorText || ""
			: editorText || viewData || cached || "";
	}

	private commitReadingModeFootnoteText(
		footnoteId: string,
		newText: string,
	) {
		const view = this.getMarkdownView();
		const file = view?.file ?? this.app.workspace.getActiveFile();
		if (!file) return;

		const rewrite = (content: string): string | null => {
			const escapedId = footnoteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(
				`^(\\[\\^${escapedId}\\]:\\s*)(.+(?:\\n(?:[ \\t]+.+)*)?)$`,
				"gm",
			);

			const match = regex.exec(content);
			if (!match) return null; // no change

			const prefix = match[1] ?? "";
			const before = content.slice(0, match.index + prefix.length);
			const after = content.slice(match.index + match[0].length);

			return before + newText + after;
		};

		void this.app.vault.process(
			file,
			(content) => rewrite(content) ?? content,
		);

		// Patch the cache in place so re-opening the sidenote before the async
		// file write lands reads the new text rather than the stale source.
		// Only when the cache is this file's — patching another file's cached
		// content would corrupt it.
		if (this.cachedSourcePath === file.path && this.cachedSourceContent) {
			const patched = rewrite(this.cachedSourceContent);
			if (patched) this.cachedSourceContent = patched;
		}
	}

	/**
	 * Reading-mode counterpart to `commitHtmlSpanSidenoteText`. Same rewrite,
	 * but through `vault.process` — see `isPreviewMode` for why the editor
	 * path cannot be used here.
	 */
	private commitReadingModeHtmlSpanText(
		originalText: string,
		newText: string,
	) {
		const view = this.getMarkdownView();
		const file = view?.file ?? this.app.workspace.getActiveFile();
		if (!file) return;

		const rewrite = (content: string): string | null => {
			const regex = SIDENOTE_SPAN_REGEX();
			let match: RegExpExecArray | null;

			while ((match = regex.exec(content)) !== null) {
				if (match[1] !== originalText) continue;

				// Preserve the opening tag verbatim so per-note class overrides
				// (`sidenote right`, `sidenote margin-note left`) survive.
				const openingTag = match[0].substring(
					0,
					match[0].indexOf(">") + 1,
				);
				return (
					content.slice(0, match.index) +
					`${openingTag}${newText}</span>` +
					content.slice(match.index + match[0].length)
				);
			}
			return null;
		};

		void this.app.vault.process(
			file,
			(content) => rewrite(content) ?? content,
		);

		if (this.cachedSourcePath === file.path && this.cachedSourceContent) {
			const patched = rewrite(this.cachedSourceContent);
			if (patched) this.cachedSourceContent = patched;
		}
	}

	// ==================== Mode Calculation ====================

	// ==================== Reading Mode Layout ====================

	private scheduleReadingModeLayout() {
		window.requestAnimationFrame(() => {
			const view = this.getMarkdownView();
			if (!view) return;

			const readingRoot = view.containerEl.querySelector<HTMLElement>(
				".markdown-reading-view",
			);
			if (!readingRoot) return;

			const width = readingRoot.getBoundingClientRect().width;
			const mode = applyRootMetrics(this.settings, readingRoot, width);

			// Check if we have sidenotes
			const hasMargins =
				readingRoot.querySelectorAll("small.sidenote-margin").length > 0;

			// If no margins exist but we should have sidenotes, reprocess
			if (!hasMargins && this.documentHasSidenotes && mode !== "hidden") {
				this.processReadingModeSidenotes(readingRoot);
				return;
			}

			// Update positioning and run collision avoidance
			if (mode !== "hidden" && hasMargins) {
				window.requestAnimationFrame(() =>
					positionReadingSidenotes(this, readingRoot, {
						recomputeLineOffsets: false,
					}),
				);
			}
		});
	}

	// ==================== Document Scanning ====================

	private scanDocumentForSidenotes() {
		const view = this.getMarkdownView();
		if (!view) {
			this.documentHasSidenotes = false;
			this.documentSidenoteSides = { left: false, right: false };
			return;
		}

		// Resolve the source text through the full fallback chain rather than
		// trusting the editor. `editor.getValue()` returns "" on a reading-only
		// leaf, and `view.editor` can be absent entirely — either way the old
		// code concluded the document had no sidenotes at all. That false
		// negative is what left reading mode blank after a mode flip:
		// `documentHasSidenotes` gates the rebuild in scheduleReadingModeLayout,
		// so nothing reprocessed until a scroll happened to re-fire the
		// post-processor for a section.
		const content = this.getSourceText();

		if (content) {
			this.setCachedSource(content, view.file?.path ?? null);
		}

		if (!content) {
			this.documentHasSidenotes = false;
			this.documentSidenoteSides = { left: false, right: false };
			return;
		}

		if (this.settings.sidenoteFormat === "html") {
			this.documentHasSidenotes = SIDENOTE_PATTERN().test(content);
			SIDENOTE_PATTERN().lastIndex = 0;
		} else {
			this.documentHasSidenotes = /\[\^[^\]]+\](?!:)/.test(content);
		}

		this.documentSidenoteSides = this.scanSidenoteSides(content);

		// Check if we're in Source mode
		const cmRoot = this.cmRoot;
		const isSourceMode =
			cmRoot && !cmRoot.classList.contains("is-live-preview");

		if (cmRoot) {
			let editingHasSidenotes = false;

			// Sidenotes only exist in Live Preview — Source mode shows the
			// bare markdown
			if (isSourceMode) {
				editingHasSidenotes = false;
			} else if (this.settings.sidenoteFormat === "html") {
				editingHasSidenotes = SIDENOTE_PATTERN().test(content);
				SIDENOTE_PATTERN().lastIndex = 0;
			} else if (this.settings.sidenoteFormat === "footnote-edit") {
				editingHasSidenotes = /\[\^[^\]]+\](?!:)/.test(content);
			}
			// For "footnote" format, editing mode has no sidenotes at all

			cmRoot.dataset.hasSidenotes = editingHasSidenotes ? "true" : "false";
		}

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			readingRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";
		}
	}

	/**
	 * Work out which margins the document's sidenotes occupy by reading the
	 * SOURCE text, so the answer covers the whole document rather than just
	 * the portion currently mounted in a virtualised view. Notes without an
	 * explicit override count toward the document-wide "Sidenote position".
	 */
	private scanSidenoteSides(
		content: string,
	): Record<SidenoteSide, boolean> {
		const sides: Record<SidenoteSide, boolean> = {
			left: false,
			right: false,
		};
		if (!content) return sides;

		const defaultSide = this.settings.sidenotePosition;
		let match: RegExpExecArray | null;

		if (this.settings.sidenoteFormat === "html") {
			const regex = SIDENOTE_CLASS_CAPTURE_REGEX();
			while ((match = regex.exec(content)) !== null) {
				const classes = (match[1] ?? "").split(/\s+/);
				let side: SidenoteSide | null = null;
				if (classes.includes("right")) {
					side = "right";
				} else if (classes.includes("left")) {
					side = "left";
				}
				sides[side ?? defaultSide] = true;
			}
		} else {
			// Footnote refs (not definitions); the -r/-l suffix is read by
			// getSidenoteSideOverride, which also handles the mn- prefix.
			const regex = /\[\^([^\]]+)\](?!:)/g;
			while ((match = regex.exec(content)) !== null) {
				const side = getSidenoteSideOverride(match[1] ?? "");
				sides[side ?? defaultSide] = true;
			}
		}

		return sides;
	}

	/**
	 * Re-read source content from the editor and update the cache.
	 * Call this after any commit (editing or reading mode) so that
	 * subsequent mode switches and undo operations see fresh data.
	 */
	public refreshCachedSourceContent() {
		const view = this.getMarkdownView();
		const editorText = view?.editor?.getValue();
		const viewData = (view as { data?: string })?.data;

		// Source order matters. The editor is authoritative while editing, but
		// in preview its document can lag the file — and this runs right after
		// a reading-mode commit wrote through vault.process, so preferring the
		// editor there would overwrite the fresh text with the pre-edit copy.
		const content = this.isPreviewMode()
			? viewData || editorText || ""
			: editorText || viewData || "";

		if (content) {
			this.setCachedSource(content, view?.file?.path ?? null);
		}
	}

	/**
	 * Parse footnote definitions from the document content.
	 * Returns a map of footnote ID to footnote text.
	 */
	private parseFootnoteDefinitions(content: string): Map<string, string> {
		return parseFootnoteDefinitions(content);
	}

	// ==================== Scheduling ====================

	private rebindAndSchedule() {
		this.rebind();
		this.scheduler.scheduleLayout();
	}

	// ==================== Binding ====================

	private rebind() {
		// First confirm we have a view and something to bind to before tearing
		// down the old setup.
		const view = this.getMarkdownView();
		if (!view) return; // Don't tear down if there's no view to bind to

		const root = view.containerEl;
		const cmRoot = root.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		const readingRoot = root.querySelector<HTMLElement>(
			".markdown-reading-view",
		);

		// A leaf opened straight into reading mode may have no source view at
		// all. Bailing here used to skip the reading-mode scroll and mutation
		// listeners entirely, so nothing ever re-resolved collisions and
		// overlapping sidenotes stayed overlapped.
		if (!cmRoot && !readingRoot) return;

		// Only now tear down the old setup, after confirming we have something
		// new to bind to.
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		this.scheduler.clearVisible();

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		// Handle resize events with a debounce to prevent thrashing
		let resizeTimeout: number | null = null;
		let lastObservedWidth = 0;

		this.resizeObserver = new ResizeObserver((entries) => {
			const entry = entries[0];
			const currentWidth = entry?.contentRect?.width ?? 0;

			if (Math.abs(currentWidth - lastObservedWidth) < 1) return;
			lastObservedWidth = currentWidth;

			if (resizeTimeout !== null) {
				window.clearTimeout(resizeTimeout);
			}
			resizeTimeout = window.setTimeout(() => {
				resizeTimeout = null;
				this.scheduler.scheduleLayout();
				this.scheduleReadingModeLayout();
			}, 50);
		});

		// Store cleanup for the resize timeout
		this.cleanups.push(() => {
			if (resizeTimeout !== null) {
				window.clearTimeout(resizeTimeout);
				resizeTimeout = null;
			}
		});

		if (cmRoot) {
			this.cmRoot = cmRoot;

			cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";
			cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
			// cmRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

			this.resizeObserver.observe(cmRoot);
		} else {
			// Reading-only leaf: don't keep pointing at another view's editor.
			this.cmRoot = null;
		}

		if (readingRoot) {
			this.resizeObserver.observe(readingRoot);
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;
			readingRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

			const onReadingScroll = () => {
				this.scheduler.scheduleReadingScroll(
					() => updateCollisionsIn(this.settings, readingRoot),
					100,
				);
			};

			// Listen on the reading root in the capture phase rather than on
			// .markdown-preview-view. Scroll doesn't bubble, but it does
			// capture, so this keeps working when the preview scroller is
			// mounted (or replaced) after rebind — previously we resolved the
			// scroller once and silently fell back to a non-scrolling element.
			readingRoot.addEventListener("scroll", onReadingScroll, {
				passive: true,
				capture: true,
			});
			this.cleanups.push(() =>
				readingRoot.removeEventListener("scroll", onReadingScroll, {
					capture: true,
				}),
			);

			// Re-process reading mode when Obsidian virtualizes/mounts new preview DOM
			const readingContent =
				readingRoot.querySelector<HTMLElement>(
					".markdown-preview-sizer",
				) ?? readingRoot;

			let readingMutationTimer: number | null = null;

			const readingMo = new MutationObserver((mutations) => {
				// Skip while margin editing (prevents flicker)
				if (this.isEditingMargin) return;

				// Only react to added/removed nodes; characterData churn can be noisy
				let relevant = false;
				for (const m of mutations) {
					if (m.type !== "childList") continue;
					if (m.addedNodes.length || m.removedNodes.length) {
						relevant = true;
						break;
					}
				}
				if (!relevant) return;

				if (readingMutationTimer !== null)
					window.clearTimeout(readingMutationTimer);
				readingMutationTimer = window.setTimeout(() => {
					readingMutationTimer = null;
					if (this.settings.sidenoteFormat === "html") {
						// HTML sidenotes have no footnote refs for
						// scheduleFootnoteProcessing to find, so newly
						// virtualized <span class="sidenote"> sections need
						// their own reprocessing pass here.
						window.requestAnimationFrame(() => {
							window.requestAnimationFrame(() => {
								this.processReadingModeSidenotes(readingRoot);
							});
						});
					} else {
						// This will now run even if <section.footnotes> is not mounted
						this.scheduleFootnoteProcessing();
					}
				}, 75);
			});

			readingMo.observe(readingContent, {
				childList: true,
				subtree: true,
			});

			this.cleanups.push(() => {
				readingMo.disconnect();
				if (readingMutationTimer !== null) {
					window.clearTimeout(readingMutationTimer);
					readingMutationTimer = null;
				}
			});
		}

		if (!cmRoot) return;

		const scroller = cmRoot.querySelector<HTMLElement>(".cm-scroller");
		if (!scroller) return;

		const onScroll = () => {
			this.scheduler.scheduleEditorScroll(() =>
				this.scheduler.scheduleLayout(),
			);
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		this.cleanups.push(() =>
			scroller.removeEventListener("scroll", onScroll),
		);

		const content = cmRoot.querySelector<HTMLElement>(".cm-content");
		if (content) {
			const mo = new MutationObserver(() => {
				if (this.isMutating) return;
				this.scheduler.scheduleLayoutDebounced();
			});
			mo.observe(content, {
				childList: true,
				subtree: true,
				characterData: true,
			});
			this.cleanups.push(() => mo.disconnect());
		}

		// Watch for Live Preview / Source mode toggle on cmRoot
		const modeMo = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (
					mutation.type === "attributes" &&
					mutation.attributeName === "class"
				) {
					// View mode changed, reschedule layout
					this.invalidateLayoutCache();
					this.scheduler.scheduleLayout();
					break;
				}
			}
		});
		modeMo.observe(cmRoot, {
			attributes: true,
			attributeFilter: ["class"],
		});
		this.cleanups.push(() => modeMo.disconnect());
	}

	// ==================== Document Position ====================

	public getDocumentPosition(el: HTMLElement): number | null {
		const view = this.getMarkdownView();
		if (!view) return null;

		const editor = (view.editor as { cm?: EditorView })?.cm;
		if (!editor?.state || !editor?.lineBlockAt) return null;

		const lineEl = el.closest(".cm-line");
		if (!lineEl) return null;

		const rect = lineEl.getBoundingClientRect();

		const pos = editor.posAtCoords({
			x: rect.left,
			y: rect.top + rect.height / 2,
		});
		if (pos === null) return null;

		const spanRect = el.getBoundingClientRect();
		const offsetInLine = spanRect.left - rect.left;

		return pos * 10000 + Math.floor(offsetInLine);
	}

	// ==================== Registry Management ====================

	private resetRegistry() {
		this.headingSidenoteNumbers.clear();
	}

	// ==================== Main Layout ====================

	private layout() {
		const cmRoot = this.cmRoot;
		if (!cmRoot) {
			return;
		}

		const cmRootRect = cmRoot.getBoundingClientRect();
		const editorWidth = cmRootRect.width;
		const mode = calculateMode(this.settings, editorWidth);

		// console.log("[Sidenotes] layout():", {
		// 	editorWidth,
		// 	mode,
		// 	isConnected: cmRoot.isConnected,
		// 	unwrappedCount: cmRoot.querySelectorAll(
		// 		"span.sidenote:not(.sidenote-number span.sidenote)",
		// 	).length,
		// 	wrappedCount: cmRoot.querySelectorAll("small.sidenote-margin")
		// 		.length,
		// });

		applyRootMetrics(this.settings, cmRoot, editorWidth);

		// Check if we're in Source mode (not Live Preview)
		const isSourceMode = !cmRoot.classList.contains("is-live-preview");

		// Determine if we should process sidenotes in editing mode
		// const processHtmlSidenotes = this.settings.sidenoteFormat === "html";
		const processFootnoteSidenotes =
			this.settings.sidenoteFormat === "footnote-edit" && !isSourceMode;

		// Source mode shows the raw markdown — no sidenotes, and no page
		// offset reserving margin space for them
		if (isSourceMode) {
			cmRoot.dataset.hasSidenotes = "false";
			return;
		}

		// For footnote-edit mode, the CM6 widget handles the sidenotes
		// We just need to set the data attributes and run collision avoidance
		if (processFootnoteSidenotes) {
			cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";

			// Run positioning and collision avoidance for widget-created margins
			if (mode !== "hidden" && this.documentHasSidenotes) {
				window.setTimeout(() => {
					positionEditingSidenotes(this, cmRoot);
				}, TIMING.WIDGET_LAYOUT_DELAY);
			}
			return;
		}

		// For reading-only footnote mode, don't process anything in editing
		if (this.settings.sidenoteFormat === "footnote") {
			cmRoot.dataset.hasSidenotes = "false";
			return;
		}

		buildEditingHtmlSidenotes(this, cmRoot, mode);
	}

	/**
	 * Remove all sidenote markup (wrappers and margins) so we can renumber from scratch.
	 * This unwraps the original span.sidenote elements and footnote ref spans.
	 */
	public removeAllSidenoteMarkup(root: HTMLElement) {
		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
			this.runPopupCleanup(wrapper);

			const sidenoteSpan =
				wrapper.querySelector<HTMLElement>("span.sidenote");

			const margin = wrapper.querySelector<HTMLElement>(
				"small.sidenote-margin",
			);
			if (margin) {
				// Call cleanup if it exists
				const snMargin = margin as SidenoteMarginElement;
				if (snMargin._sidenoteCleanup) {
					snMargin._sidenoteCleanup();
					delete snMargin._sidenoteCleanup;
				}
				this.unobserveSidenoteVisibility(margin);
				margin.remove();
			}

			if (sidenoteSpan && wrapper.parentNode) {
				wrapper.parentNode.insertBefore(sidenoteSpan, wrapper);
			}

			wrapper.remove();
		}
	}

	// ==================== Text Normalization ====================

	private normalizeText(s: string): string {
		return normalizeText(s);
	}

	/**
	 * Set up a click handler on the sidenote wrapper to select only the text content,
	 * not the HTML tags, when clicked in the editor.
	 */
	public setupSidenoteClickHandler(
		wrapper: HTMLElement,
		sidenoteText: string,
	) {
		wrapper.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			if (target.closest(".sidenote-margin")) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();

			const view = this.getMarkdownView();
			if (!view?.editor) return;

			const editor = view.editor;

			const found = this.findHtmlSidenoteInSource(sidenoteText);
			if (found) {
				const openingTagEnd = found.openingTag.length;
				const textStart = found.index + openingTagEnd;
				const textEnd = textStart + found.text.length;

				const from = editor.offsetToPos(textStart);
				const to = editor.offsetToPos(textEnd);

				editor.setSelection(from, to);
				editor.focus();
			}
		});
	}

	// ==================== Margin Editing ====================

	/**
	 * Set up a margin element to be editable in place.
	 * When clicked, it becomes editable. On blur, changes are saved to the source.
	 */
	public setupMarginEditing(
		margin: HTMLElement,
		sourceSpan: HTMLElement,
		docPos: number | null,
		sidenoteIndex: number,
	) {
		margin.dataset.editing = "false";
		margin.dataset.sidenoteIndex = String(sidenoteIndex);

		const onMouseDown = (e: MouseEvent) => {
			// When editing, allow normal mousedown behavior for cursor positioning
			if (margin.dataset.editing === "true") {
				// Don't stop propagation or prevent default - let browser handle cursor
				return;
			}
			e.stopPropagation();
			e.preventDefault();
		};

		const onClick = (e: MouseEvent) => {
			// When editing, allow normal click behavior
			if (margin.dataset.editing === "true") {
				e.stopPropagation(); // Still prevent clicks from bubbling to parent elements
				return;
			}

			e.preventDefault();
			e.stopPropagation();
			this.startMarginEdit(margin, sourceSpan, sidenoteIndex, e);
		};

		margin.addEventListener("mousedown", onMouseDown);
		margin.addEventListener("click", onClick);

		// Store cleanup reference on the element for later removal
		(margin as SidenoteMarginElement)._sidenoteCleanup = () => {
			margin.removeEventListener("mousedown", onMouseDown);
			margin.removeEventListener("click", onClick);
		};
	}

	/**
	 * Start editing a margin sidenote in place.
	 */
	public startMarginEdit(
		margin: HTMLElement,
		sourceSpan: HTMLElement,
		_sidenoteIndex: number,
		_clickEvent?: MouseEvent,
	) {
		if (this.spanEditor) return;

		// Read current text from source by matching content
		const marginText = margin.textContent ?? "";
		const found = this.findHtmlSidenoteInSource(marginText);
		const originalText = found?.text ?? sourceSpan.textContent ?? "";

		margin.dataset.editing = "true";
		margin.innerHTML = "";

		this.spanEditor = openInlineMarkdownEditor({
			app: this.app,
			parent: margin,
			doc: originalText,
			outsideBoundary: [margin],
			onClose: ({ text, renderText, changed }) => {
				this.spanEditor = null;
				margin.dataset.editing = "false";

				if (changed) {
					this.commitHtmlSpanSidenoteText(originalText, text);
				}

				margin.innerHTML = "";
				margin.appendChild(
					this.renderLinksToFragment(this.normalizeText(renderText)),
				);

				// Margin height changed (editor -> rendered text); restack.
				this.scheduler.scheduleCollisions();
			},
		});
	}

	private commitHtmlSpanSidenoteText(
		originalText: string,
		newText: string,
	) {
		// Reading mode (and popups opened from it) must not write via the
		// editor — the change would render but never reach the file.
		if (this.isPreviewMode()) {
			this.commitReadingModeHtmlSpanText(originalText, newText);
			return;
		}

		const view = this.getMarkdownView();
		if (!view?.editor) return;

		const editor = view.editor;

		const scroller =
			this.cmRoot?.querySelector<HTMLElement>(".cm-scroller");
		const scrollTop = scroller?.scrollTop ?? 0;

		this.isEditingMargin = true;

		const content = editor.getValue();
		const regex = SIDENOTE_SPAN_REGEX();
		let match: RegExpExecArray | null;

		while ((match = regex.exec(content)) !== null) {
			if (match[1] === originalText) {
				const from = editor.offsetToPos(match.index);
				const to = editor.offsetToPos(match.index + match[0].length);

				const originalTag = match[0].substring(
					0,
					match[0].indexOf(">") + 1,
				);
				const newSpan = `${originalTag}${newText}</span>`;

				this.isMutating = true;
				try {
					editor.replaceRange(newSpan, from, to);
				} finally {
					this.isMutating = false;
				}
				break;
			}
		}

		if (scroller) scroller.scrollTop = scrollTop;
		this.isEditingMargin = false;
	}

	private commitFootnoteSidenoteText(footnoteId: string, newText: string) {
		// Same reasoning as commitHtmlSpanSidenoteText: this is reachable from
		// a margin-note popup opened in reading mode.
		if (this.isPreviewMode()) {
			this.commitReadingModeFootnoteText(footnoteId, newText);
			return;
		}

		const view = this.getMarkdownView();
		if (!view?.editor) return;

		const editor = view.editor;
		const content = editor.getValue();

		const defRegex = new RegExp(
			`^(\\[\\^${footnoteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]:\\s*)(.*)$`,
			"m",
		);
		const match = content.match(defRegex);
		if (!match || match.index === undefined || !match[1]) return;

		const from = editor.offsetToPos(match.index + match[1].length);
		const to = editor.offsetToPos(match.index + match[0].length);

		this.isMutating = true;
		try {
			editor.replaceRange(newText, from, to);
		} finally {
			this.isMutating = false;
		}
	}

	// ==================== Collision Avoidance ====================

	/** The reading view root for the active markdown view, if there is one. */
	private getReadingRoot(): HTMLElement | null {
		return (
			this.getMarkdownView()?.containerEl.querySelector<HTMLElement>(
				".markdown-reading-view",
			) ?? null
		);
	}

	/**
	 * Schedule collision resolution for whichever root(s) currently hold margins.
	 *
	 * Uses its own rAF handle: `rafId` belongs to scheduleLayout, and gating on
	 * it meant a pending layout silently dropped the collision request instead
	 * of deferring it, leaving sidenotes stacked on top of each other.
	 */
	public scheduleCollisionUpdate() {
		this.scheduler.scheduleCollisions();
	}

	//
	/**
	 * Render markdown-formatted text to a DocumentFragment.
	 * Supports: **bold**, *italic*, _italic_, `code`, [links](url), and [[wiki links]]
	 * @param text The markdown-formatted text to render
	 */
	private renderLinksToFragment(text: string): DocumentFragment {
		return renderLinksToFragment(text, this.app);
	}

	/**
	 * Convert a margin note wrapper to popup mode:
	 * hide the margin, show an ⓘ icon inline, and display
	 * content in a small popup on click.
	 */
	public setupMarginNotePopup(
		wrapper: HTMLElement,
		margin: HTMLElement,
		contentText: string,
		editable: boolean = false,
		footnoteId?: string,
	) {
		wrapper.classList.add("popup-mode");
		margin.classList.add("popup-mode-margin");

		margin.innerHTML = "";
		const icon = createSpan();
		icon.className = "margin-note-icon";
		icon.setAttribute("aria-label", "Show margin note");

		const iconSetting = this.settings.popupIcon || "ⓘ";

		if (
			iconSetting.endsWith(".png") ||
			iconSetting.endsWith(".svg") ||
			iconSetting.endsWith(".jpg")
		) {
			// Image file from plugin assets folder
			const img = createEl("img");
			img.src = this.app.vault.adapter.getResourcePath(
				`${this.manifest.dir}/assets/${iconSetting}`,
			);
			img.className = "margin-note-icon-img";
			icon.appendChild(img);
		} else {
			// Unicode character
			icon.textContent = iconSetting;
		}

		margin.appendChild(icon);

		const popup = createDiv();
		popup.className = "margin-note-popup";

		const closeBtn = createSpan();
		closeBtn.className = "margin-note-popup-close";
		closeBtn.textContent = "✕";
		closeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			popup.classList.remove("is-visible");
		});
		popup.appendChild(closeBtn);

		const contentEl = createDiv();
		contentEl.className = "margin-note-popup-content";

		let currentRawText = contentText;

		if (editable) {
			let popupEditor: InlineEditorHandle | null = null;
			let isEditing = false;

			const renderReadOnly = () => {
				contentEl.innerHTML = "";
				contentEl.appendChild(
					this.renderLinksToFragment(this.normalizeText(currentRawText)),
				);
				contentEl.classList.add("margin-note-popup-content--readable");
				isEditing = false;
			};

			const commitAndClosePopup = (commit: boolean) => {
				popupEditor?.close({ commit });
			};

			const openEditor = () => {
				// Defensive: the content click handler bails while isEditing,
				// so there should be no editor open here.
				popupEditor?.close({ commit: false });

				contentEl.innerHTML = "";
				popup.classList.add("is-visible");
				isEditing = true;

				popupEditor = openInlineMarkdownEditor({
					app: this.app,
					parent: contentEl,
					doc: currentRawText,
					// The popup installs its own document-level click handler
					// further down; the editor's would double-fire.
					outsideBoundary: null,
					stopKeydownPropagation: true,
					onClose: ({ text, changed }) => {
						popupEditor = null;

						if (changed) {
							if (footnoteId) {
								this.commitFootnoteSidenoteText(footnoteId, text);
							} else {
								this.commitHtmlSpanSidenoteText(currentRawText, text);
							}
							currentRawText = text;
						}

						isEditing = false;
						contentEl.innerHTML = "";
						popup.classList.remove("is-visible");
					},
				});
			};

			// Click on content: if clicking a link, let it open; otherwise start editing
			contentEl.addEventListener("click", (e) => {
				if (isEditing) return;

				const target = e.target as HTMLElement;
				if (target.tagName === "A" || target.closest("a")) {
					// Let the link open naturally
					return;
				}

				e.preventDefault();
				e.stopPropagation();
				openEditor();
			});

			// Listen for links being clicked, close popup when that happens
			contentEl.addEventListener(
				"click",
				(e) => {
					const target = e.target as HTMLElement;
					if (target.tagName === "A" || target.closest("a")) {
						// Close popup when a link is clicked
						popup.classList.remove("is-visible");
					}
				},
				true,
			);

			contentEl.addEventListener("mousedown", (e) => {
				e.stopPropagation();
			});

			icon.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();

				const isVisible = popup.classList.contains("is-visible");

				document
					.querySelectorAll(".margin-note-popup.is-visible")
					.forEach((el) => el.classList.remove("is-visible"));

				if (!isVisible) {
					const iconRect = icon.getBoundingClientRect();
					popup.style.top = `${iconRect.bottom + window.scrollY + 4}px`;
					popup.style.left = `${iconRect.left + window.scrollX}px`;
					popup.classList.add("is-visible");
					renderReadOnly();
				} else {
					if (popupEditor) {
						commitAndClosePopup(true);
					} else {
						popup.classList.remove("is-visible");
					}
				}
			});

			icon.addEventListener("mousedown", (e) => {
				e.stopPropagation();
			});

			const onOutsideClick = (e: MouseEvent) => {
				if (
					!popup.contains(e.target as Node) &&
					!icon.contains(e.target as Node)
				) {
					if (popupEditor) {
						commitAndClosePopup(true);
					} else {
						popup.classList.remove("is-visible");
					}
				}
			};
			document.addEventListener("click", onOutsideClick, true);

			(wrapper as SidenoteWrapperElement)._popupCleanup = () => {
				document.removeEventListener("click", onOutsideClick, true);
				popupEditor?.close({ commit: false });
				popup.remove();
			};

			popup.appendChild(contentEl);
			document.body.appendChild(popup);
			return;
		}

		// Read-only path
		contentEl.appendChild(
			this.renderLinksToFragment(this.normalizeText(contentText)),
		);

		popup.appendChild(contentEl);
		document.body.appendChild(popup);

		icon.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();

			const isVisible = popup.classList.contains("is-visible");

			document
				.querySelectorAll(".margin-note-popup.is-visible")
				.forEach((el) => el.classList.remove("is-visible"));

			if (!isVisible) {
				const iconRect = icon.getBoundingClientRect();
				popup.style.top = `${iconRect.bottom + window.scrollY + 4}px`;
				popup.style.left = `${iconRect.left + window.scrollX}px`;
				popup.classList.add("is-visible");
			}
		});

		icon.addEventListener("mousedown", (e) => {
			e.stopPropagation();
		});

		const onOutsideClick = (e: MouseEvent) => {
			if (
				!popup.contains(e.target as Node) &&
				!icon.contains(e.target as Node)
			) {
				popup.classList.remove("is-visible");
			}
		};
		document.addEventListener("click", onOutsideClick, true);

		(
			wrapper as HTMLElement & { _popupCleanup?: () => void }
		)._popupCleanup = () => {
			document.removeEventListener("click", onOutsideClick, true);
			popup.remove();
		};
	}
}
