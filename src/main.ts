/* eslint-disable obsidianmd/ui/sentence-case */
import {
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	App,
	EditorPosition,
} from "obsidian";
import {
	EditorView,
	ViewUpdate,
	ViewPlugin,
	Decoration,
	DecorationSet,
	WidgetType,
	keymap,
	Command,
} from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";

// CM6 building blocks for proper shortcuts + undo
import {
	defaultKeymap,
	history,
	historyKeymap,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
	defaultHighlightStyle,
	syntaxHighlighting,
} from "@codemirror/language";

type CleanupFn = () => void;

// Near the top of the file, with your other type definitions
interface SidenoteMarginElement extends HTMLElement {
	_sidenoteCleanup?: () => void;
}

/** Minimal subset of Obsidian's Editor interface backed by a CM6 EditorView. */
interface MinimalEditor {
	getValue(): string;
	getLine(line: number): string;
	lineCount(): number;
	getCursor(): EditorPosition;
	setCursor(pos: EditorPosition): void;
	setSelection(anchor: EditorPosition, head?: EditorPosition): void;
	getSelection(): string;
	replaceSelection(text: string): void;
	getRange(from: EditorPosition, to: EditorPosition): string;
	replaceRange(
		text: string,
		from: EditorPosition,
		to?: EditorPosition,
	): void;
}

// Settings interface
interface SidenoteSettings {
	// Source format
	sidenoteFormat: "html" | "footnote" | "footnote-edit";
	hideFootnotes: boolean;
	hideFootnoteNumbers: boolean;

	// Display
	sidenotePosition: "left" | "right";
	showSidenoteNumbers: boolean;
	numberStyle: "arabic" | "roman" | "letters";
	numberBadgeStyle: "plain" | "neumorphic" | "pill";
	numberColor: string;

	// Width & Spacing
	minSidenoteWidth: number;
	maxSidenoteWidth: number;
	sidenoteGap: number;
	sidenoteGap2: number;
	sidenoteAnchor: "text" | "edge";
	pageOffsetFactor: number;

	// Breakpoints
	hideBelow: number;
	compactBelow: number;
	fullAbove: number;

	// Typography
	fontSize: number;
	fontSizeCompact: number;
	lineHeight: number;
	textAlignment: "left" | "right" | "justify";

	// Behavior
	collisionSpacing: number;
	enableTransitions: boolean;
	resetNumberingPerHeading: boolean;
}

const DEFAULT_SETTINGS: SidenoteSettings = {
	// Source format
	sidenoteFormat: "html",
	hideFootnotes: false,
	hideFootnoteNumbers: true,

	// Display
	sidenotePosition: "left",
	showSidenoteNumbers: true,
	numberStyle: "arabic",
	numberBadgeStyle: "plain",
	numberColor: "",

	// Width & Spacing
	minSidenoteWidth: 10,
	maxSidenoteWidth: 18,
	sidenoteGap: 2,
	sidenoteGap2: 1,
	sidenoteAnchor: "text",
	pageOffsetFactor: 0,

	// Breakpoints
	hideBelow: 700,
	compactBelow: 1000,
	fullAbove: 1400,

	// Typography
	fontSize: 80,
	fontSizeCompact: 70,
	lineHeight: 1.35,
	textAlignment: "right",

	// Behavior
	collisionSpacing: 8,
	enableTransitions: true,
	resetNumberingPerHeading: false,
};

// Regex to detect sidenote spans in source text
const SIDENOTE_PATTERN = /<span\s+class\s*=\s*["']sidenote["'][^>]*>/gi;

// ======================================================
// ================= Main Plugin Class ==================
// ======================================================
export default class SidenotePlugin extends Plugin {
	settings: SidenoteSettings;

	private rafId: number | null = null;
	private cleanups: CleanupFn[] = [];
	private cmRoot: HTMLElement | null = null;
	private isMutating = false;
	private resizeObserver: ResizeObserver | null = null;
	private styleEl: HTMLStyleElement | null = null;

	// Map from sidenote text content (or position) to assigned number
	private sidenoteRegistry: Map<string, number> = new Map();
	private nextSidenoteNumber = 1;
	private headingSidenoteNumbers: Map<string, number> = new Map();

	// Track whether current document has any sidenotes
	private documentHasSidenotes = false;
	private needsFullRenumber = true;

	// Performance: Debounce/throttle timers
	private scrollDebounceTimer: number | null = null;
	private mutationDebounceTimer: number | null = null;
	private resizeThrottleTime: number = 0;

	// Performance: Layout caching
	private lastLayoutWidth: number = 0;
	private lastSidenoteCount: number = 0;
	private lastMode: string = "";

	// Performance: Visible sidenotes tracking
	private visibilityObserver: IntersectionObserver | null = null;
	private visibleSidenotes: Set<HTMLElement> = new Set();

	private totalSidenotesInDocument = 0;
	private isEditingMargin = false;
	private readingModeScrollTimer: number | null = null;

	private footnoteProcessingTimer: number | null = null;
	private footnoteProcessingRetries = 0;
	private needsReadingModeRefresh = true;

	private pendingFootnoteEdit: string | null = null;
	private pendingFootnoteEditRetries = 0;

	// Cached source content for reading mode (editor.getValue() can be empty)
	private cachedSourceContent: string = "";

	// Timing constants (in milliseconds)
	private static readonly RESIZE_DEBOUNCE = 100;
	private static readonly SCROLL_DEBOUNCE = 50;
	private static readonly MUTATION_DEBOUNCE = 100;
	private static readonly FOOTNOTE_RENDER_DELAY = 100;
	private static readonly WIDGET_LAYOUT_DELAY = 50;
	private static readonly EDIT_TRIGGER_DELAY = 50;
	private static readonly INSERT_SIDENOTE_DELAY = 150;
	private static readonly MAX_FOOTNOTE_EDIT_RETRIES = 10;

	private activeEditingMargin: HTMLElement | null = null;

	private spanCmView: EditorView | null = null;
	private spanOutsidePointerDown?: (ev: PointerEvent) => void;
	private spanOriginalText: string = "";

	// Track the currently editing margin element for the global capture listener
	private currentlyEditingMargin: HTMLElement | null = null;

	// Track which footnote is being edited (by footnote ID)
	private activeFootnoteEdit: string | null = null;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new SidenoteSettingTab(this.app, this));
		this.injectStyles();
		this.setupVisibilityObserver();

		// Register the CM6 extension for footnote sidenotes in editing mode
		this.registerEditorExtension([createFootnoteSidenotePlugin(this)]);

		// Add command to insert sidenote
		this.addCommand({
			id: "insert-sidenote",
			name: "Insert sidenote",
			editorCallback: (editor) => {
				const cursor = editor.getCursor();
				const selectedText = editor.getSelection();

				if (this.settings.sidenoteFormat === "html") {
					if (selectedText) {
						editor.replaceSelection(
							`<span class="sidenote">${selectedText}</span>`,
						);
					} else {
						const sidenoteText = '<span class="sidenote"></span>';
						editor.replaceRange(sidenoteText, cursor);
						const newCursor = {
							line: cursor.line,
							ch: cursor.ch + '<span class="sidenote">'.length,
						};
						editor.setCursor(newCursor);
					}
				} else {
					// Footnote format - need to find next available footnote number
					const content = editor.getValue();
					const existingRefs = content.match(/\[\^(\d+)\]/g) ?? [];
					const usedNumbers = existingRefs.map((fn) => {
						const match = fn.match(/\[\^(\d+)\]/);
						return match && match[1] ? parseInt(match[1], 10) : 0;
					});
					const nextNum =
						usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 1;

					// Determine the content for the footnote
					const footnoteContent = selectedText
						? selectedText
						: "New sidenote";

					// Find where footnote definitions are in the document
					const lines = content.split("\n");
					let lastFootnoteLine = -1;

					for (let i = 0; i < lines.length; i++) {
						const line = lines[i];
						if (line && line.match(/^\[\^[^\]]+\]:/)) {
							lastFootnoteLine = i;
						}
					}

					// Build the definition
					const definition = `[^${nextNum}]: ${footnoteContent}`;

					// Insert the reference at cursor
					editor.replaceRange(`[^${nextNum}]`, cursor);

					// Re-read content after first insertion
					const updatedContent = editor.getValue();
					const updatedLines = updatedContent.split("\n");

					if (lastFootnoteLine === -1) {
						// No existing footnotes - add at the very end with blank lines
						const lastLine = editor.lastLine();
						const lastLineContent = editor.getLine(lastLine);
						const prefix = lastLineContent.trim() ? "\n\n" : "\n";
						editor.replaceRange(prefix + definition, {
							line: lastLine,
							ch: lastLineContent.length,
						});
					} else {
						// Find the last footnote line again in the updated content
						let newLastFootnoteLine = -1;
						for (let i = 0; i < updatedLines.length; i++) {
							const line = updatedLines[i];
							if (line && line.match(/^\[\^[^\]]+\]:/)) {
								newLastFootnoteLine = i;
							}
						}

						if (newLastFootnoteLine !== -1) {
							// Insert after the last footnote
							const insertLineContent = editor.getLine(
								newLastFootnoteLine,
							);
							editor.replaceRange("\n" + definition, {
								line: newLastFootnoteLine,
								ch: insertLineContent.length,
							});
						}
					}

					// Set flag to auto-edit this footnote when the widget appears
					this.pendingFootnoteEdit = String(nextNum);

					// Schedule the auto-edit after widgets are rendered
					setTimeout(() => {
						this.triggerPendingFootnoteEdit();
					}, SidenotePlugin.INSERT_SIDENOTE_DELAY);
				}
			},
		});

		this.registerMarkdownPostProcessor((element, context) => {
			let hasContent = false;

			if (this.settings.sidenoteFormat === "html") {
				hasContent = element.querySelectorAll("span.sidenote").length > 0;
			} else {
				hasContent =
					element.querySelectorAll("sup.footnote-ref, section.footnotes")
						.length > 0;
			}

			if (hasContent) {
				// console.log(
				// 	"[Sidenotes] Post-processor: found content, format =",
				// 	this.settings.sidenoteFormat,
				// );
				if (this.settings.sidenoteFormat !== "html") {
					// For footnotes, use the debounced processor that waits
					// for both refs AND definitions to be present
					this.scheduleFootnoteProcessing();
				} else {
					setTimeout(() => {
						requestAnimationFrame(() => {
							requestAnimationFrame(() => {
								this.processReadingModeSidenotes(element);
							});
						});
					}, 0);
				}
			}
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.resetRegistry();
				this.invalidateLayoutCache();
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.rebindAndSchedule();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () =>
				this.rebindAndSchedule(),
			),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (_file: TFile | null) => {
				this.resetRegistry();
				this.invalidateLayoutCache();
				this.footnoteProcessingRetries = 0;
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.rebindAndSchedule();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				if (this.isEditingMargin) return;
				this.needsReadingModeRefresh = true;
				this.scanDocumentForSidenotes();
				this.needsFullRenumber = true;
				this.invalidateLayoutCache();
				this.scheduleLayoutDebounced(SidenotePlugin.MUTATION_DEBOUNCE);
			}),
		);

		this.registerDomEvent(window, "resize", () => {
			this.needsReadingModeRefresh = true;
			this.scheduleLayoutThrottled(SidenotePlugin.RESIZE_DEBOUNCE);
			this.scheduleReadingModeLayoutThrottled(100);
		});

		this.scanDocumentForSidenotes();
		this.rebindAndSchedule();
	}

	onunload() {
		this.cancelAllTimers();
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		// Clear pending edit
		this.pendingFootnoteEdit = null;
		this.pendingFootnoteEditRetries = 0;
		this.currentlyEditingMargin = null;

		// Clear active footnote edit
		this.activeFootnoteEdit = null;

		// Clean up footnote processing timer
		if (this.footnoteProcessingTimer !== null) {
			window.clearTimeout(this.footnoteProcessingTimer);
			this.footnoteProcessingTimer = null;
		}

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		if (this.visibilityObserver) {
			this.visibilityObserver.disconnect();
			this.visibilityObserver = null;
		}

		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
		}

		// Clean up reading mode scroll timer
		if (this.readingModeScrollTimer !== null) {
			window.clearTimeout(this.readingModeScrollTimer);
			this.readingModeScrollTimer = null;
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		this.cleanupView(view);

		// Remove CSS custom properties and data attributes
		const root = document.documentElement;
		const propsToRemove = Array.from(root.style).filter((p) =>
			p.startsWith("--sn-"),
		);
		for (const prop of propsToRemove) {
			root.style.removeProperty(prop);
		}
		delete root.dataset.snBadgeStyle;
		delete root.dataset.snShowNumbers;
		delete root.dataset.snFormat;
		delete root.dataset.snHideFootnotes;
		delete root.dataset.snHideFootnoteNumbers;
	}

	// Add public methods that the widget can call
	public renderLinksToFragmentPublic(text: string): DocumentFragment {
		return this.renderLinksToFragment(text);
	}

	public normalizeTextPublic(s: string): string {
		return this.normalizeText(s);
	}

	public parseFootnoteDefinitionsPublic(
		content: string,
	): Map<string, string> {
		return this.parseFootnoteDefinitions(content);
	}

	public formatNumberPublic(num: number): string {
		return this.formatNumber(num);
	}

	public scheduleEditingModeCollisionUpdate() {
		this.scheduleCollisionUpdate();
	}

	public getActiveFootnoteEdit(): string | null {
		return this.activeFootnoteEdit;
	}

	public setActiveFootnoteEdit(footnoteId: string | null) {
		this.activeFootnoteEdit = footnoteId;
	}

	public isFootnoteBeingEdited(): boolean {
		return this.activeFootnoteEdit !== null;
	}

	public setCurrentlyEditingMargin(margin: HTMLElement | null) {
		this.currentlyEditingMargin = margin;
	}

	public getCurrentlyEditingMargin(): HTMLElement | null {
		return this.currentlyEditingMargin;
	}

	private cleanupView(view: MarkdownView | null) {
		if (!view) return;

		const cmRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (cmRoot) {
			cmRoot
				.querySelectorAll("span.sidenote-number")
				.forEach((n) => n.remove());
			cmRoot
				.querySelectorAll("small.sidenote-margin")
				.forEach((n) => n.remove());
			cmRoot.style.removeProperty("--editor-width");
			cmRoot.style.removeProperty("--sidenote-scale");
			cmRoot.dataset.sidenoteMode = "";
			cmRoot.dataset.hasSidenotes = "";
			cmRoot.dataset.sidenotePosition = "";
		}

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			readingRoot
				.querySelectorAll("span.sidenote-number")
				.forEach((n) => n.remove());
			readingRoot
				.querySelectorAll("small.sidenote-margin")
				.forEach((n) => n.remove());
			readingRoot.style.removeProperty("--editor-width");
			readingRoot.style.removeProperty("--sidenote-scale");
			readingRoot.dataset.sidenoteMode = "";
			readingRoot.dataset.hasSidenotes = "";
			readingRoot.dataset.sidenotePosition = "";

			// Clear processed flags
			readingRoot
				.querySelectorAll("[data-sidenotes-processed]")
				.forEach((el) => {
					delete (el as HTMLElement).dataset.sidenotesProcessed;
				});
		}
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

			// Full cleanup and refresh
			this.cleanupCurrentView();
			this.injectStyles();
			this.resetRegistry();
			this.invalidateLayoutCache();
			this.scanDocumentForSidenotes();
			this.rebindAndSchedule();

			// Force reprocess reading mode
			this.forceReadingModeRefresh();
		} catch (error) {
			console.error("Sidenote plugin: Failed to save settings", error);
		}
	}

	/**
	 * Clean up sidenote markup from the current view.
	 */
	private cleanupCurrentView() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		// Clean up editing mode
		const cmRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (cmRoot) {
			// Remove all sidenote wrappers and margins
			this.removeAllSidenoteMarkup(cmRoot);

			// Reset data attributes
			cmRoot.dataset.sidenoteMode = "";
			cmRoot.dataset.hasSidenotes = "";
		}

		// Clean up reading mode
		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			// Remove all sidenote markup
			this.removeAllSidenoteMarkupFromReadingMode(readingRoot);

			// Reset data attributes
			readingRoot.dataset.sidenoteMode = "";
			readingRoot.dataset.hasSidenotes = "";
		}
	}

	/**
	 * Force a refresh of reading mode sidenotes.
	 */
	private forceReadingModeRefresh() {
		this.needsReadingModeRefresh = true;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
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

		// Reset the mode so it gets recalculated
		readingRoot.dataset.sidenoteMode = "";
		readingRoot.style.removeProperty("--sidenote-scale");

		// Schedule reprocessing with a delay to ensure cleanup is complete
		setTimeout(() => {
			const useFootnotes =
				this.settings.sidenoteFormat === "footnote" ||
				this.settings.sidenoteFormat === "footnote-edit";

			if (useFootnotes) {
				// Wait until footnote defs are present, then process.
				this.scheduleFootnoteProcessing();
				return;
			}

			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					this.processReadingModeSidenotes(readingRoot);
				});
			});
		}, SidenotePlugin.FOOTNOTE_RENDER_DELAY);
	}

	/**
	 * Trigger editing mode for a newly inserted footnote sidenote.
	 */
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
				setTimeout(() => {
					this.triggerPendingFootnoteEdit();
				}, SidenotePlugin.FOOTNOTE_RENDER_DELAY);
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

		// Simulate a click to start editing
		margin.click();

		// After editing starts, select all the text
		setTimeout(() => {
			const selection = window.getSelection();
			if (selection && margin.contentEditable === "true") {
				const range = document.createRange();
				range.selectNodeContents(margin);
				selection.removeAllRanges();
				selection.addRange(range);
			}
		}, SidenotePlugin.EDIT_TRIGGER_DELAY);
	}

	// ==================== Performance Utilities ====================

	private cancelAllTimers() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		if (this.scrollDebounceTimer !== null) {
			window.clearTimeout(this.scrollDebounceTimer);
			this.scrollDebounceTimer = null;
		}
		if (this.mutationDebounceTimer !== null) {
			window.clearTimeout(this.mutationDebounceTimer);
			this.mutationDebounceTimer = null;
		}
	}

	private invalidateLayoutCache() {
		this.lastLayoutWidth = 0;
		this.lastSidenoteCount = 0;
		this.lastMode = "";
		// this.lastCollisionHash = "";
	}

	private scheduleLayoutDebounced(
		delay: number = SidenotePlugin.MUTATION_DEBOUNCE,
	) {
		if (this.mutationDebounceTimer !== null) {
			window.clearTimeout(this.mutationDebounceTimer);
		}
		this.mutationDebounceTimer = window.setTimeout(() => {
			this.mutationDebounceTimer = null;
			this.scheduleLayout();
		}, delay);
	}

	private scheduleLayoutThrottled(
		minInterval: number = SidenotePlugin.RESIZE_DEBOUNCE,
	) {
		const now = Date.now();
		if (now - this.resizeThrottleTime >= minInterval) {
			this.resizeThrottleTime = now;
			this.scheduleLayout();
		}
	}

	private scheduleReadingModeLayoutThrottled(
		minInterval: number = SidenotePlugin.RESIZE_DEBOUNCE,
	) {
		const now = Date.now();
		if (now - this.resizeThrottleTime >= minInterval) {
			this.scheduleReadingModeLayout();
		}
	}

	private setupVisibilityObserver() {
		this.visibilityObserver = new IntersectionObserver(
			(entries) => {
				let needsCollisionUpdate = false;
				for (const entry of entries) {
					const el = entry.target as HTMLElement;

					// Check if element is still in the DOM
					if (!el.isConnected) {
						this.visibleSidenotes.delete(el);
						continue;
					}

					if (entry.isIntersecting) {
						if (!this.visibleSidenotes.has(el)) {
							this.visibleSidenotes.add(el);
							needsCollisionUpdate = true;
						}
					} else {
						if (this.visibleSidenotes.has(el)) {
							this.visibleSidenotes.delete(el);
							needsCollisionUpdate = true;
						}
					}
				}
				if (needsCollisionUpdate) {
					this.scheduleCollisionUpdate();
				}
			},
			{
				rootMargin: "100px 0px",
				threshold: 0,
			},
		);
	}

	private observeSidenoteVisibility(margin: HTMLElement) {
		if (this.visibilityObserver) {
			this.visibilityObserver.observe(margin);
		}
	}

	private unobserveSidenoteVisibility(margin: HTMLElement) {
		if (this.visibilityObserver) {
			this.visibilityObserver.unobserve(margin);
			this.visibleSidenotes.delete(margin);
		}
	}

	// ==================== Style Injection ====================

	private injectStyles() {
		const s = this.settings;
		const root = document.documentElement;

		// Layout variables
		root.style.setProperty("--sn-base-width", `${s.minSidenoteWidth}rem`);
		root.style.setProperty(
			"--sn-max-extra",
			`${s.maxSidenoteWidth - s.minSidenoteWidth}rem`,
		);
		root.style.setProperty("--sn-gap", `${s.sidenoteGap}rem`);
		root.style.setProperty("--sn-gap2", `${s.sidenoteGap2}rem`);
		root.style.setProperty(
			"--sn-page-offset-factor",
			`${s.pageOffsetFactor}`,
		);

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
		root.style.setProperty(
			"--sn-base-width-full",
			`${s.maxSidenoteWidth}rem`,
		);
		root.style.setProperty("--sn-gap-full", `${s.sidenoteGap + 1}rem`);
		root.style.setProperty("--sn-gap2-full", `${s.sidenoteGap2 + 0.5}rem`);

		// Typography
		root.style.setProperty("--sn-font-size", `${s.fontSize}%`);
		root.style.setProperty(
			"--sn-font-size-compact",
			`${s.fontSizeCompact}%`,
		);
		root.style.setProperty("--sn-line-height", `${s.lineHeight}`);
		root.style.setProperty(
			"--sn-line-height-compact",
			`${Math.max(s.lineHeight - 0.1, 1.1)}`,
		);

		// Text alignment
		const defaultAlignment =
			s.sidenotePosition === "left" ? "right" : "left";
		const textAlign =
			s.textAlignment === "justify"
				? "justify"
				: s.textAlignment === "left" || s.textAlignment === "right"
					? s.textAlignment
					: defaultAlignment;
		root.style.setProperty("--sn-text-align", textAlign);

		// Number color
		root.style.setProperty(
			"--sn-number-color",
			s.numberColor || "inherit",
		);

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
		root.dataset.snHideFootnoteNumbers = s.hideFootnoteNumbers
			? "true"
			: "false";
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
	private updateSidenotePositioning(
		root: HTMLElement,
		isReadingMode: boolean,
	) {
		const s = this.settings;
		const position = s.sidenotePosition;
		const anchorMode = s.sidenoteAnchor;

		// Get rem to px conversion
		const remToPx =
			parseFloat(getComputedStyle(document.documentElement).fontSize) ||
			16;
		const gap1 = s.sidenoteGap * remToPx; // gap between sidenote and text
		const gap2 = s.sidenoteGap2 * remToPx; // gap between sidenote and edge

		// Get root element rect
		const rootRect = root.getBoundingClientRect();

		// Find a representative line/paragraph to measure from
		// This is the element that sidenotes are positioned relative to
		let refLine: HTMLElement | null = null;
		if (isReadingMode) {
			refLine = root.querySelector<HTMLElement>(
				".markdown-preview-sizer > div > p, .markdown-preview-sizer > div > .sidenote-number",
			);
			if (!refLine) {
				refLine = root.querySelector<HTMLElement>(
					".markdown-preview-sizer",
				);
			}
		} else {
			refLine = root.querySelector<HTMLElement>(".cm-line");
		}

		if (!refLine) return;

		const refRect = refLine.getBoundingClientRect();

		// Get sidenote width from computed styles
		const computedStyle = getComputedStyle(root);
		const sidenoteWidthStr = computedStyle
			.getPropertyValue("--sidenote-width")
			.trim();
		// Get sidenote width from an existing margin element, or fall back to calculation
		let sidenoteWidth = s.minSidenoteWidth * remToPx;

		const existingMargin = root.querySelector<HTMLElement>(
			"small.sidenote-margin",
		);
		if (existingMargin) {
			sidenoteWidth = existingMargin.getBoundingClientRect().width;
		} else if (sidenoteWidthStr) {
			// Parse the calc() manually from the CSS variable values
			const scale =
				parseFloat(
					getComputedStyle(root).getPropertyValue("--sidenote-scale"),
				) || 0.5;
			const baseWidth = s.minSidenoteWidth * remToPx;
			const maxExtra = (s.maxSidenoteWidth - s.minSidenoteWidth) * remToPx;
			sidenoteWidth = baseWidth + maxExtra * scale;
		}

		if (position === "left") {
			// Available space between editor left edge and the text (refLine left edge)
			const availableSpace = refRect.left - rootRect.left;

			// Calculate the CSS left value (negative = to the left of refLine)
			let cssLeft: number;

			if (anchorMode === "text") {
				// TEXT ANCHOR MODE:
				// Position sidenote so its right edge is exactly gap1 from text
				// sidenote.right = refLine.left - gap1
				// sidenote.left = sidenote.right - sidenoteWidth = refLine.left - gap1 - sidenoteWidth
				// cssLeft (relative to refLine.left) = -(gap1 + sidenoteWidth)
				cssLeft = -(gap1 + sidenoteWidth);

				// Constraint: sidenote.left must be at least gap2 from editor edge
				// sidenote.left (absolute) = refLine.left + cssLeft
				// sidenote.left >= rootRect.left + gap2
				// refLine.left + cssLeft >= rootRect.left + gap2
				// cssLeft >= rootRect.left + gap2 - refLine.left = gap2 - availableSpace
				const minCssLeft = gap2 - availableSpace;
				if (cssLeft < minCssLeft) {
					// Not enough space - pull sidenote towards text to maintain gap2 from edge
					cssLeft = minCssLeft;
				}
			} else {
				// EDGE ANCHOR MODE:
				// Position sidenote so its left edge is exactly gap2 from editor edge
				// sidenote.left (absolute) = rootRect.left + gap2
				// cssLeft (relative to refLine.left) = sidenote.left - refLine.left = rootRect.left + gap2 - refLine.left = gap2 - availableSpace
				cssLeft = gap2 - availableSpace;

				// Constraint: sidenote.right must be at least gap1 from text
				// sidenote.right = refLine.left + cssLeft + sidenoteWidth
				// sidenote.right <= refLine.left - gap1
				// cssLeft + sidenoteWidth <= -gap1
				// cssLeft <= -(gap1 + sidenoteWidth)
				const maxCssLeft = -(gap1 + sidenoteWidth);
				if (cssLeft > maxCssLeft) {
					// Not enough space - push sidenote away from text to maintain gap1
					cssLeft = maxCssLeft;
				}
			}

			root.style.setProperty("--sidenote-offset", `${cssLeft}px`);
		} else {
			// RIGHT POSITION
			// Available space between text (refLine right edge) and editor right edge
			const availableSpace = rootRect.right - refRect.right;

			let cssRight: number;

			if (anchorMode === "text") {
				// TEXT ANCHOR MODE:
				// Position sidenote so its left edge is exactly gap1 from text
				// cssRight works inversely: negative moves element to the right
				cssRight = -(gap1 + sidenoteWidth);

				// Constraint: sidenote.right must be at least gap2 from editor edge
				const minCssRight = gap2 - availableSpace;
				if (cssRight < minCssRight) {
					cssRight = minCssRight;
				}
			} else {
				// EDGE ANCHOR MODE:
				// Position sidenote so its right edge is exactly gap2 from editor edge
				cssRight = gap2 - availableSpace;

				// Constraint: sidenote.left must be at least gap1 from text
				const maxCssRight = -(gap1 + sidenoteWidth);
				if (cssRight > maxCssRight) {
					cssRight = maxCssRight;
				}
			}

			root.style.setProperty("--sidenote-offset", `${cssRight}px`);
		}
	}

	/**
	 * Correct per-sidenote horizontal position in reading mode.
	 *
	 * The global --sidenote-offset is computed relative to a reference line
	 * (typically the first <p>). But each sidenote's position:absolute is
	 * relative to its own positioned ancestor (p, li, blockquote, etc.).
	 * When the positioned ancestor is indented (e.g. nested list items),
	 * the sidenote shifts inward. This method corrects each margin's
	 * left/right so all sidenotes align on the same vertical line.
	 */
	private correctReadingModeHorizontalPositions(root: HTMLElement) {
		const position = this.settings.sidenotePosition;

		// Find the same reference line that updateSidenotePositioning used
		let refLine: HTMLElement | null = root.querySelector<HTMLElement>(
			".markdown-preview-sizer > div > p, .markdown-preview-sizer > div > .sidenote-number",
		);
		if (!refLine) {
			refLine = root.querySelector<HTMLElement>(".markdown-preview-sizer");
		}
		if (!refLine) return;

		const refRect = refLine.getBoundingClientRect();

		// Read the global offset that was just set
		const globalOffset =
			parseFloat(root.style.getPropertyValue("--sidenote-offset")) || 0;

		const margins = root.querySelectorAll<HTMLElement>(
			"small.sidenote-margin",
		);

		for (const margin of Array.from(margins)) {
			// Find the positioned parent for this margin
			const wrapper = margin.closest<HTMLElement>("span.sidenote-number");
			if (!wrapper) continue;

			const positionedParent =
				(wrapper.closest(
					"p, li, h1, h2, h3, h4, h5, h6, blockquote, .callout",
				) as HTMLElement | null) ??
				(wrapper.parentElement as HTMLElement | null);

			if (!positionedParent) continue;

			const parentRect = positionedParent.getBoundingClientRect();

			if (position === "left") {
				// Global offset is relative to refLine's left edge.
				// This margin's position:absolute is relative to parentRect.left.
				// Correction: shift left by the difference.
				const correction = refRect.left - parentRect.left;
				if (Math.abs(correction) > 0.5) {
					margin.style.left = `${globalOffset + correction}px`;
				} else {
					// No correction needed — clear any previously set inline style
					margin.style.removeProperty("left");
				}
			} else {
				// Global offset is relative to refLine's right edge.
				// This margin's position:absolute right is relative to parentRect.right.
				// Correction: adjust for the difference in right edges.
				const correction = parentRect.right - refRect.right;
				if (Math.abs(correction) > 0.5) {
					margin.style.right = `${globalOffset + correction}px`;
				} else {
					margin.style.removeProperty("right");
				}
			}
		}
	}

	// ==================== Number Formatting ====================

	private formatNumber(num: number): string {
		switch (this.settings.numberStyle) {
			case "roman":
				return this.toRoman(num);
			case "letters":
				return this.toLetters(num);
			case "arabic":
			default:
				return String(num);
		}
	}

	private toRoman(num: number): string {
		const romanNumerals: [number, string][] = [
			[1000, "m"],
			[900, "cm"],
			[500, "d"],
			[400, "cd"],
			[100, "c"],
			[90, "xc"],
			[50, "l"],
			[40, "xl"],
			[10, "x"],
			[9, "ix"],
			[5, "v"],
			[4, "iv"],
			[1, "i"],
		];
		let result = "";
		for (const [value, numeral] of romanNumerals) {
			while (num >= value) {
				result += numeral;
				num -= value;
			}
		}
		return result || "i";
	}

	private toLetters(num: number): string {
		if (num <= 0) return "a"; // Handle edge case
		let result = "";
		while (num > 0) {
			num--;
			result = String.fromCharCode(97 + (num % 26)) + result;
			num = Math.floor(num / 26);
		}
		return result;
	}

	// ==================== Reading Mode Processing ====================

	private processReadingModeSidenotes(element: HTMLElement) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (!readingRoot) return;

		// If sidenotes are already built and the source hasn't changed, skip.
		const existingMargins = readingRoot.querySelectorAll(
			"small.sidenote-margin",
		).length;
		if (existingMargins > 0 && !this.needsReadingModeRefresh) {
			return;
		}
		this.needsReadingModeRefresh = false;

		// console.log("[Sidenotes] processReadingModeSidenotes called");

		const rect = readingRoot.getBoundingClientRect();
		const width = rect.width;

		readingRoot.style.setProperty("--editor-width", `${width}px`);

		const mode = this.calculateMode(width);
		readingRoot.dataset.sidenoteMode = mode;
		readingRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
		readingRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

		const scaleFactor = this.calculateScaleFactor(width);
		readingRoot.style.setProperty(
			"--sidenote-scale",
			scaleFactor.toFixed(3),
		);

		if (mode === "hidden") {
			// console.log(
			// 	"[Sidenotes] Mode is 'hidden' (width:",
			// 	width,
			// 	") — skipping",
			// );
			return;
		}

		// First, remove any existing sidenote markup in the reading root to start fresh
		this.removeAllSidenoteMarkupFromReadingMode(readingRoot);

		const sizer =
			readingRoot.querySelector<HTMLElement>(".markdown-preview-sizer") ??
			readingRoot;

		const sizerRect = sizer.getBoundingClientRect();

		// Baseline element that represents the main body text column.
		// Prefer a non-list paragraph; fall back to any paragraph; then sizer.
		const baselineEl =
			sizer.querySelector<HTMLElement>(":scope > p") ??
			sizer.querySelector<HTMLElement>("p") ??
			sizer;

		const baselineRect = baselineEl.getBoundingClientRect();
		const baselineX = baselineRect.left - sizerRect.left;

		// Collect items based on the sidenoteFormat setting
		// Note: footnoteHtml is optional and only used for footnotes
		const allItems: {
			el: HTMLElement;
			rect: DOMRect;
			type: "sidenote" | "footnote";
			text: string;
			footnoteId?: string;
			footnoteHtml?: HTMLElement;
		}[] = [];

		// Determine what to collect
		const useHtmlSidenotes = this.settings.sidenoteFormat === "html";
		const useFootnotes =
			this.settings.sidenoteFormat === "footnote" ||
			this.settings.sidenoteFormat === "footnote-edit";

		if (useHtmlSidenotes) {
			// Get HTML sidenote spans
			const spans = Array.from(
				readingRoot.querySelectorAll<HTMLElement>("span.sidenote"),
			).filter(
				(span) =>
					!span.parentElement?.classList.contains("sidenote-number"),
			);

			for (const el of spans) {
				allItems.push({
					el,
					rect: el.getBoundingClientRect(),
					type: "sidenote",
					text: el.textContent ?? "",
				});
			}
		}

		if (useFootnotes) {
			// Get footnote definitions from SOURCE MARKDOWN, not from rendered HTML.
			// Obsidian uses virtualized rendering — the <section class="footnotes">
			// may not exist in the DOM for long documents where it's off-screen.

			// Try multiple methods to get source content (in order of reliability):
			// 1. view.editor.getValue() — works in editing mode, sometimes in reading mode
			// 2. (view as any).data — Obsidian's cached file content (always available)
			// 3. this.cachedSourceContent — cached from scanDocumentForSidenotes()
			const view2 = this.app.workspace.getActiveViewOfType(MarkdownView);
			let sourceContent =
				view2?.editor?.getValue() ||
				(view2 as any)?.data ||
				this.cachedSourceContent ||
				"";

			// If still empty, try async cachedRead as last resort
			if (!sourceContent) {
				const file = view2?.file ?? this.app.workspace.getActiveFile();
				if (file) {
					void this.app.vault.cachedRead(file).then((text) => {
						const current =
							this.app.workspace.getActiveViewOfType(MarkdownView);
						if (!current || current.file?.path !== file.path) return;
						// Cache the result so the next call succeeds synchronously
						this.cachedSourceContent = text;
						this.scheduleFootnoteProcessing();
					});
				}
				if (!useHtmlSidenotes) return;
			}

			const definitions = this.parseFootnoteDefinitions(sourceContent);

			// console.log(
			// 	"[Sidenotes] Source content length:",
			// 	sourceContent.length,
			// 	"| Definitions found:",
			// 	definitions.size,
			// 	"| Keys:",
			// 	Array.from(definitions.keys()),
			// );

			if (definitions.size === 0) {
				if (!useHtmlSidenotes) return;
			}

			// Find all footnote references in the rendered HTML
			const footnoteSups = readingRoot.querySelectorAll<HTMLElement>(
				// Obsidian preview often uses sup#fnref-* with a.footnote-link
				"sup.footnote-ref, sup[class*='footnote'], sup[id^='fnref-'], sup[data-footnote-id], a.footnote-link",
			);

			const processedBaseIds = new Set<string>();

			// console.log(
			// 	"[Sidenotes] Found footnote sups in DOM:",
			// 	footnoteSups.length,
			// 	"| Elements:",
			// 	Array.from(footnoteSups).map((el) => ({
			// 		tag: el.tagName,
			// 		id: el.id,
			// 		class: el.className,
			// 		dataFootnoteId: el.dataset.footnoteId,
			// 		text: el.textContent?.trim(),
			// 	})),
			// );

			for (const sup of Array.from(footnoteSups)) {
				if (sup.closest(".sidenote-number")) continue;
				// Skip elements inside the footnotes section (these are backrefs, not refs)
				if (sup.closest("section.footnotes, .footnotes")) continue;

				// Try multiple ways to extract the base footnote ID
				const supId = sup.dataset.footnoteId || sup.id || "";
				const anchor = sup.querySelector("a");
				const anchorHref = anchor?.getAttribute("href") || "";
				const anchorId = anchor?.id || "";

				let baseId: string | null = null;

				// Try from sup ID/data: fnref-1-hash or fnref-1
				for (const rawId of [supId, anchorId]) {
					if (!rawId) continue;
					const hashMatch = rawId.match(/^fnref-(.+?)-[a-f0-9]+$/i);
					if (hashMatch?.[1]) {
						baseId = hashMatch[1];
						break;
					}
					const simpleMatch = rawId.match(/^fnref-(.+)$/i);
					if (simpleMatch?.[1]) {
						baseId = simpleMatch[1];
						break;
					}
				}

				// Try from href: #fn-1-hash or #fn-1
				if (!baseId && anchorHref) {
					const hrefMatch = anchorHref.match(/#fn-(.+?)-[a-f0-9]+$/i);
					if (hrefMatch?.[1]) {
						baseId = hrefMatch[1];
					} else {
						const hrefSimple = anchorHref.match(/#fn-(.+)$/i);
						if (hrefSimple?.[1]) {
							baseId = hrefSimple[1];
						}
					}
				}

				// Last resort: use the displayed number text
				if (!baseId) {
					const supText = sup.textContent?.trim() || "";
					const numMatch = supText.match(/^\[?(\d+)\]?$/);
					if (numMatch?.[1]) {
						baseId = numMatch[1];
					}
				}

				if (!baseId || processedBaseIds.has(baseId)) continue;
				processedBaseIds.add(baseId);

				// Look up definition from SOURCE markdown
				const footnoteText = definitions.get(baseId);
				if (!footnoteText) continue;

				// For footnotes, hide the original [1] link
				if (anchor && this.settings.hideFootnoteNumbers) {
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

		if (allItems.length === 0) {
			readingRoot.dataset.hasSidenotes = "false";
			return;
		}

		readingRoot.dataset.hasSidenotes = "true";

		// Sort by vertical position. Items with valid rects sort by top position;
		// items with zero rects (not yet laid out) sort by their DOM order,
		// which querySelectorAll already preserves.
		allItems.sort((a, b) => a.rect.top - b.rect.top);

		// Start numbering from 1
		let num = 1;

		const marginNotes: HTMLElement[] = [];

		for (const item of allItems) {
			if (this.settings.resetNumberingPerHeading) {
				const heading = this.findPrecedingHeading(item.el);
				if (heading) {
					const headingId = this.getHeadingId(heading);
					if (!this.headingSidenoteNumbers.has(headingId)) {
						this.headingSidenoteNumbers.set(headingId, 1);
					}
					num = this.headingSidenoteNumbers.get(headingId)!;
					this.headingSidenoteNumbers.set(headingId, num + 1);
				}
			}

			// For footnotes, use the footnote's own ID as the number
			// (so [^3] always displays as "3" regardless of which refs are visible).
			// For HTML sidenotes, use the sequential counter.
			const numStr = item.footnoteId
				? item.footnoteId
				: this.formatNumber(num++);

			const wrapper = document.createElement("span");
			wrapper.className = "sidenote-number";
			wrapper.dataset.sidenoteNum = numStr;
			if (item.footnoteId) {
				wrapper.dataset.footnoteId = item.footnoteId;
			}

			const margin = document.createElement("small");
			margin.className = "sidenote-margin";
			margin.dataset.sidenoteNum = numStr;

			if (item.type === "sidenote") {
				this.cloneContentToMargin(item.el, margin);
			} else {
				// For footnotes, hide the original [1] link inside the sup
				const anchor = item.el.querySelector("a.footnote-link");
				if (anchor && this.settings.hideFootnoteNumbers) {
					anchor.classList.add("sidenote-fn-link-hidden");
				}

				// Render from source markdown text
				margin.appendChild(
					this.renderLinksToFragment(this.normalizeText(item.text)),
				);

				margin.dataset.editing = "false";

				// COMMENTED OUT TO DISABLE EDITING IN READING MODE FOR NOW
				// Set up margin click-to-edit for footnotes
				// if (item.footnoteId) {
				// 	const footnoteId = item.footnoteId;

				// 	// Initialize editing state
				// 	margin.dataset.editing = "false";

				// 	margin.addEventListener("mousedown", (e) => {
				// 		// When editing, allow normal mousedown behavior for cursor positioning
				// 		if (margin.contentEditable === "true") {
				// 			return;
				// 		}
				// 		e.stopPropagation();
				// 		e.preventDefault();
				// 	});

				// 	margin.addEventListener("click", (e) => {
				// 		// When editing, allow normal click behavior
				// 		if (margin.contentEditable === "true") {
				// 			e.stopPropagation();
				// 			return;
				// 		}

				// 		e.preventDefault();
				// 		e.stopPropagation();
				// 		this.startReadingModeMarginEdit(margin, footnoteId, e);
				// 	});
				// }
			}

			item.el.parentNode?.insertBefore(wrapper, item.el);
			wrapper.appendChild(item.el);
			wrapper.appendChild(margin);

			// Add click handler on wrapper to trigger margin editing (for footnote sidenotes)
			// COMMENTED OUT TO DISABLE EDITING IN READING MODE FOR NOW
			// if (item.type === "footnote" && item.footnoteId) {
			// 	const footnoteId = item.footnoteId;

			// 	wrapper.addEventListener("click", (e) => {
			// 		// Don't trigger if clicking on the margin itself
			// 		if ((e.target as HTMLElement).closest(".sidenote-margin")) {
			// 			return;
			// 		}

			// 		// Don't trigger if already editing
			// 		if (margin.contentEditable === "true") {
			// 			return;
			// 		}

			// 		e.preventDefault();
			// 		e.stopPropagation();

			// 		this.startReadingModeMarginEdit(margin, footnoteId);
			// 	});

			// 	wrapper.addEventListener("mousedown", (e) => {
			// 		if ((e.target as HTMLElement).closest(".sidenote-margin")) {
			// 			// If margin is being edited, allow normal behavior
			// 			if (margin.contentEditable === "true") {
			// 				return;
			// 			}
			// 		}
			// 		e.stopPropagation();
			// 	});
			// }

			// Reading mode: correct horizontal offset so list indentation doesn't shift the margin column
			// Find the nearest container that is responsible for indentation (li is the common case)
			const li = wrapper.closest("li") as HTMLElement | null;

			if (li) {
				const liRect = li.getBoundingClientRect();

				const containerX = liRect.left - sizerRect.left;
				const indentPx = containerX - baselineX;

				if (Math.abs(indentPx) > 0.5) {
					if (this.settings.sidenotePosition === "left") {
						wrapper.style.setProperty(
							"--sidenote-offset",
							`calc(-1 * (var(--sidenote-width) + var(--sidenote-gap)) - ${indentPx}px)`,
						);
					} else {
						wrapper.style.setProperty(
							"--sidenote-offset",
							`calc(-1 * (var(--sidenote-width) + var(--sidenote-gap)) + ${indentPx}px)`,
						);
					}
				} else {
					wrapper.style.removeProperty("--sidenote-offset");
				}
			} else {
				wrapper.style.removeProperty("--sidenote-offset");
			}

			// Calculate line offset: how far down from the positioned parent is this reference?
			this.applyLineOffset(wrapper, margin, false);

			this.observeSidenoteVisibility(margin);
			marginNotes.push(margin);
		}

		// Run positioning after DOM is fully settled and elements are laid out.
		// We defer twice: once to let the browser insert elements, once to lay them out.
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (!readingRoot.isConnected) return;

				// Force reflow
				void readingRoot.offsetHeight;

				// Recompute line offsets now that elements are actually laid out
				const wrappers = readingRoot.querySelectorAll<HTMLElement>(
					"span.sidenote-number",
				);
				for (const wrapper of Array.from(wrappers)) {
					const margin = wrapper.querySelector<HTMLElement>(
						"small.sidenote-margin",
					);
					if (margin) {
						this.applyLineOffset(wrapper, margin, false);
					}
				}

				// Calculate and apply global sidenote positioning
				this.updateSidenotePositioning(readingRoot, true);

				// Correct per-sidenote horizontal position for indented parents
				// (e.g. nested list items whose left/right edges differ from refLine)
				this.correctReadingModeHorizontalPositions(readingRoot);

				this.resolveCollisions(
					marginNotes.filter((m) => m.isConnected),
					this.settings.collisionSpacing,
				);
			});
		});
	}

	private scheduleFootnoteProcessing() {
		// console.log("[Sidenotes] scheduleFootnoteProcessing called");
		// Debounce multiple calls
		if (this.footnoteProcessingTimer !== null) {
			window.clearTimeout(this.footnoteProcessingTimer);
		}

		this.footnoteProcessingTimer = window.setTimeout(() => {
			this.footnoteProcessingTimer = null;

			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
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

			// console.log(
			// 	"[Sidenotes] scheduleFootnoteProcessing: hasRefs =",
			// 	hasRefs,
			// 	"| refCount =",
			// 	refElements.length,
			// );

			if (hasRefs) {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						this.processReadingModeSidenotes(readingRoot);
					});
				});
			}
		}, 100);
	}

	/**
	 * Calculate and apply the vertical offset so the sidenote aligns with
	 * the specific line where the reference appears, not the top of the paragraph.
	 */
	private applyLineOffset(
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
				(wrapper.closest(
					"p, li, h1, h2, h3, h4, h5, h6, blockquote, .callout",
				) as HTMLElement | null) ??
				(wrapper.parentElement as HTMLElement | null);

			if (!positionedParent) return;

			// For inline content, prefer the first line box rect (more stable than getBoundingClientRect)
			const rects = wrapper.getClientRects();
			const wrapperRect = rects.length > 0 ? rects.item(0) : null;
			const effectiveWrapperRect =
				wrapperRect ?? wrapper.getBoundingClientRect();

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
	private removeAllSidenoteMarkupFromReadingMode(root: HTMLElement) {
		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
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
	}

	private findPrecedingHeading(el: HTMLElement): HTMLElement | null {
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

	private getHeadingId(heading: HTMLElement): string {
		return (
			heading.textContent?.trim() || heading.id || Math.random().toString()
		);
	}

	/**
	 * Clone content from a sidenote span to a margin element,
	 * preserving links and other HTML elements.
	 * Also sets up click handlers for internal Obsidian links.
	 */
	private cloneContentToMargin(source: HTMLElement, target: HTMLElement) {
		for (const child of Array.from(source.childNodes)) {
			const cloned = child.cloneNode(true);

			if (cloned instanceof HTMLAnchorElement) {
				this.setupLink(cloned);
			}

			if (cloned instanceof HTMLElement) {
				const links = cloned.querySelectorAll("a");
				links.forEach((link) => this.setupLink(link));
			}

			target.appendChild(cloned);
		}
	}

	/**
	 * Set up a link element with proper attributes and click handlers.
	 * Handles both external links and internal Obsidian links.
	 */
	private setupLink(link: HTMLAnchorElement) {
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
					link.getAttribute("data-href") ||
					link.getAttribute("href") ||
					"";
				if (linkTarget) {
					void this.app.workspace.openLinkText(linkTarget, "", false);
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

	// ==================== Mode Calculation ====================

	private calculateMode(
		width: number,
	): "hidden" | "compact" | "normal" | "full" {
		const s = this.settings;
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

	private calculateScaleFactor(width: number): number {
		const s = this.settings;
		if (width < s.hideBelow) {
			return 0;
		}
		return Math.min(
			1,
			(width - s.hideBelow) / (s.fullAbove - s.hideBelow),
		);
	}

	// ==================== Reading Mode Layout ====================

	private scheduleReadingModeLayout() {
		requestAnimationFrame(() => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return;

			const readingRoot = view.containerEl.querySelector<HTMLElement>(
				".markdown-reading-view",
			);
			if (!readingRoot) return;

			const rect = readingRoot.getBoundingClientRect();
			const width = rect.width;

			readingRoot.style.setProperty("--editor-width", `${width}px`);

			const mode = this.calculateMode(width);
			readingRoot.dataset.sidenoteMode = mode;
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;
			readingRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

			const scaleFactor = this.calculateScaleFactor(width);
			readingRoot.style.setProperty(
				"--sidenote-scale",
				scaleFactor.toFixed(3),
			);

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
				requestAnimationFrame(() => {
					this.updateSidenotePositioning(readingRoot, true);
					this.correctReadingModeHorizontalPositions(readingRoot);
					this.updateReadingModeCollisions();
				});
			}
		});
	}

	// ==================== Document Scanning ====================

	private scanDocumentForSidenotes() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			this.documentHasSidenotes = false;
			return;
		}

		const editor = view.editor;
		if (!editor) {
			this.documentHasSidenotes = false;
			return;
		}

		const content = editor.getValue();

		// Cache source content for reading mode
		// (view.editor.getValue() can return "" in reading mode)
		if (content) {
			this.cachedSourceContent = content;
		}

		if (this.settings.sidenoteFormat === "html") {
			this.documentHasSidenotes = SIDENOTE_PATTERN.test(content);
			SIDENOTE_PATTERN.lastIndex = 0;
		} else {
			this.documentHasSidenotes = /\[\^[^\]]+\](?!:)/.test(content);
		}

		// Count total sidenotes in document for validation
		if (this.needsFullRenumber) {
			this.totalSidenotesInDocument = this.countSidenotesInSource(content);
		}

		// Check if we're in Source mode
		const cmRoot = this.cmRoot;
		const isSourceMode =
			cmRoot && !cmRoot.classList.contains("is-live-preview");

		if (cmRoot) {
			let editingHasSidenotes = false;

			if (this.settings.sidenoteFormat === "html") {
				editingHasSidenotes = SIDENOTE_PATTERN.test(content);
				SIDENOTE_PATTERN.lastIndex = 0;
			} else if (
				this.settings.sidenoteFormat === "footnote-edit" &&
				!isSourceMode
			) {
				// Only show sidenotes in Live Preview, not Source mode
				editingHasSidenotes = /\[\^[^\]]+\](?!:)/.test(content);
			}
			// For "footnote" mode or "footnote-edit" in Source mode, editing has no sidenotes

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
	 * Count the total number of sidenotes in the source document.
	 * For editing mode, only counts sidenotes (not footnotes).
	 */
	private countSidenotesInSource(content: string): number {
		const sidenoteRegex = /<span\s+class\s*=\s*["']sidenote["'][^>]*>/gi;
		let count = 0;
		while (sidenoteRegex.exec(content) !== null) {
			count++;
		}
		return count;
	}

	/**
	 * Parse footnote definitions from the document content.
	 * Returns a map of footnote ID to footnote text.
	 */
	private parseFootnoteDefinitions(content: string): Map<string, string> {
		const definitions = new Map<string, string>();

		// Match footnote definitions: [^id]: text
		// The text can span multiple lines if indented
		const lines = content.split("\n");
		let currentId: string | null = null;
		let currentText: string[] = [];

		for (const line of lines) {
			// Check for new footnote definition
			const defMatch = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);

			if (defMatch) {
				// Save previous footnote if exists
				if (currentId !== null) {
					definitions.set(currentId, currentText.join(" ").trim());
				}

				currentId = defMatch[1] || null;
				currentText = defMatch[2] ? [defMatch[2]] : [];
			} else if (currentId !== null) {
				// Check for continuation line (indented)
				if (line.match(/^[ \t]+\S/)) {
					currentText.push(line.trim());
				} else if (line.trim() === "") {
					// Empty line might end the footnote or be part of it
					// We'll be conservative and end it
					definitions.set(currentId, currentText.join(" ").trim());
					currentId = null;
					currentText = [];
				} else {
					// Non-indented, non-empty line ends the footnote
					definitions.set(currentId, currentText.join(" ").trim());
					currentId = null;
					currentText = [];
				}
			}
		}

		// Don't forget the last footnote
		if (currentId !== null) {
			definitions.set(currentId, currentText.join(" ").trim());
		}

		return definitions;
	}

	// ==================== Scheduling ====================

	private cancelScheduled() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	private scheduleLayout() {
		this.cancelScheduled();
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.layout();
		});
	}

	private rebindAndSchedule() {
		this.rebind();
		this.scheduleLayout();
	}

	// ==================== Binding ====================

	private rebind() {
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		this.visibleSidenotes.clear();

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const root = view.containerEl;
		const cmRoot = root.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (!cmRoot) return;

		this.cmRoot = cmRoot;

		cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
			? "true"
			: "false";
		cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
		// cmRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

		let resizeTimeout: number | null = null;
		this.resizeObserver = new ResizeObserver((entries) => {
			if (resizeTimeout !== null) return;
			resizeTimeout = window.setTimeout(() => {
				resizeTimeout = null;
				this.scheduleLayout();

				// Also update reading mode on resize
				this.scheduleReadingModeLayout();
			}, 100);
		});
		this.resizeObserver.observe(cmRoot);

		// Store cleanup for the resize timeout
		this.cleanups.push(() => {
			if (resizeTimeout !== null) {
				window.clearTimeout(resizeTimeout);
				resizeTimeout = null;
			}
		});

		const readingRoot = root.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			this.resizeObserver.observe(readingRoot);
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;
			readingRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

			// Add scroll listener for reading mode collision updates
			const readingScroller =
				readingRoot.querySelector<HTMLElement>(".markdown-preview-view") ??
				readingRoot;

			const onReadingScroll = () => {
				if (this.readingModeScrollTimer !== null) {
					window.clearTimeout(this.readingModeScrollTimer);
				}
				this.readingModeScrollTimer = window.setTimeout(() => {
					this.readingModeScrollTimer = null;
					this.avoidCollisionsInReadingMode(readingRoot);
				}, 100);
			};

			readingScroller.addEventListener("scroll", onReadingScroll, {
				passive: true,
			});
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
					// This will now run even if <section.footnotes> is not mounted
					this.scheduleFootnoteProcessing();
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

		const scroller = cmRoot.querySelector<HTMLElement>(".cm-scroller");
		if (!scroller) return;

		const onScroll = () => {
			if (this.scrollDebounceTimer !== null) {
				window.clearTimeout(this.scrollDebounceTimer);
			}
			this.scrollDebounceTimer = window.setTimeout(() => {
				this.scrollDebounceTimer = null;
				this.scheduleLayout();
			}, SidenotePlugin.SCROLL_DEBOUNCE);
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		this.cleanups.push(() =>
			scroller.removeEventListener("scroll", onScroll),
		);

		const content = cmRoot.querySelector<HTMLElement>(".cm-content");
		if (content) {
			const mo = new MutationObserver(() => {
				if (this.isMutating) return;
				this.scheduleLayoutDebounced(SidenotePlugin.MUTATION_DEBOUNCE);
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
					this.scheduleLayout();
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

	private getDocumentPosition(el: HTMLElement): number | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
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
		this.sidenoteRegistry.clear();
		this.nextSidenoteNumber = 1;
		this.headingSidenoteNumbers.clear();
		this.needsFullRenumber = true;
		this.totalSidenotesInDocument = 0;
	}

	// ==================== Main Layout ====================

	private layout() {
		const cmRoot = this.cmRoot;
		if (!cmRoot) return;

		const cmRootRect = cmRoot.getBoundingClientRect();
		const editorWidth = cmRootRect.width;
		const mode = this.calculateMode(editorWidth);

		cmRoot.style.setProperty("--editor-width", `${editorWidth}px`);
		cmRoot.dataset.sidenoteMode = mode;
		cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
		cmRoot.dataset.sidenoteAnchor = this.settings.sidenoteAnchor;

		const scaleFactor = this.calculateScaleFactor(editorWidth);
		cmRoot.style.setProperty("--sidenote-scale", scaleFactor.toFixed(3));

		// Check if we're in Source mode (not Live Preview)
		const isSourceMode = !cmRoot.classList.contains("is-live-preview");

		// Determine if we should process sidenotes in editing mode
		const processHtmlSidenotes = this.settings.sidenoteFormat === "html";
		const processFootnoteSidenotes =
			this.settings.sidenoteFormat === "footnote-edit" && !isSourceMode;

		// For footnote-edit mode in Source view, don't show sidenotes
		if (this.settings.sidenoteFormat === "footnote-edit" && isSourceMode) {
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
				setTimeout(() => {
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							if (!cmRoot.isConnected) return;
							this.updateSidenotePositioning(cmRoot, false);
							this.updateEditingModeCollisions();
						});
					});
				}, SidenotePlugin.WIDGET_LAYOUT_DELAY);
			}
			return;
		}

		// For reading-only footnote mode, don't process anything in editing
		if (this.settings.sidenoteFormat === "footnote") {
			cmRoot.dataset.hasSidenotes = "false";
			return;
		}

		// HTML sidenote processing (existing logic)
		cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
			? "true"
			: "false";

		// Get unwrapped sidenote spans (not yet processed)
		const unwrappedSpans = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) => !span.parentElement?.classList.contains("sidenote-number"),
		);

		// If there are new sidenotes to process, we need to renumber everything
		if (unwrappedSpans.length > 0 && mode !== "hidden") {
			// Remove all existing sidenote wrappers and margins to renumber from scratch
			this.removeAllSidenoteMarkup(cmRoot);

			// Get the source content to determine correct indices
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view?.editor) return;

			const content = view.editor.getValue();

			// Build a map of sidenote text content + position to their index
			const sidenoteIndexMap = this.buildSidenoteOnlyIndexMap(content);

			// Now get ALL sidenote spans (they're all unwrapped now)
			const allSpans = Array.from(
				cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
			);

			if (allSpans.length === 0) {
				this.lastSidenoteCount = 0;
				return;
			}

			// Collect all sidenotes to process
			const allItems = allSpans.map((el) => ({
				el,
				docPos: this.getDocumentPosition(el),
				text: el.textContent ?? "",
			}));

			// Match each visible item to its index in the full document
			const itemsWithIndex = allItems.map((item) => {
				const index = this.findSidenoteIndex(
					sidenoteIndexMap,
					item.text,
					item.docPos,
				);
				return { ...item, index };
			});

			// Sort by index for consistent ordering
			itemsWithIndex.sort((a, b) => a.index - b.index);

			this.isMutating = true;
			try {
				for (const item of itemsWithIndex) {
					const numStr = this.formatNumber(item.index);

					const wrapper = document.createElement("span");
					wrapper.className = "sidenote-number";
					wrapper.dataset.sidenoteNum = numStr;

					const margin = document.createElement("small");
					margin.className = "sidenote-margin";
					margin.dataset.sidenoteNum = numStr;

					const raw = this.normalizeText(item.el.textContent ?? "");
					margin.appendChild(this.renderLinksToFragment(raw));

					// Make margin editable and set up edit handling
					this.setupMarginEditing(
						margin,
						item.el,
						item.docPos,
						item.index,
					);

					// Add click handler to select only text content
					this.setupSidenoteClickHandler(wrapper, item.index);

					item.el.parentNode?.insertBefore(wrapper, item.el);
					wrapper.appendChild(item.el);
					wrapper.appendChild(margin);

					// Calculate line offset for this sidenote (editing mode)
					this.applyLineOffset(wrapper, margin, true);

					this.observeSidenoteVisibility(margin);
				}
			} finally {
				this.isMutating = false;
			}

			this.lastSidenoteCount =
				cmRoot.querySelectorAll(".sidenote-margin").length;

			// Run positioning and collision avoidance after DOM is settled
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					if (!cmRoot.isConnected) return;
					this.updateSidenotePositioning(cmRoot, false);
					this.updateEditingModeCollisions();
				});
			});
		} else {
			// No new sidenotes to process
			this.lastSidenoteCount =
				cmRoot.querySelectorAll(".sidenote-margin").length;

			if (this.lastSidenoteCount > 0 && mode !== "hidden") {
				// Still run positioning and collision avoidance for existing sidenotes
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						if (!cmRoot.isConnected) return;
						this.updateSidenotePositioning(cmRoot, false);
						this.updateEditingModeCollisions();
					});
				});
			}
		}
	}

	/**
	 * Build a map of sidenotes only (not footnotes) in the source document.
	 * Used for editing mode where footnote conversion is disabled.
	 */
	private buildSidenoteOnlyIndexMap(content: string): {
		index: number;
		charPos: number;
		text: string;
	}[] {
		const items: {
			index: number;
			charPos: number;
			text: string;
		}[] = [];

		// Find all sidenotes
		const sidenoteRegex =
			/<span\s+class\s*=\s*["']sidenote["'][^>]*>([\s\S]*?)<\/span>/gi;
		let match: RegExpExecArray | null;

		while ((match = sidenoteRegex.exec(content)) !== null) {
			items.push({
				index: 0, // Will be assigned after sorting
				charPos: match.index,
				text: this.normalizeText(match[1] ?? ""),
			});
		}

		// Sort by position and assign indices
		items.sort((a, b) => a.charPos - b.charPos);
		items.forEach((item, i) => {
			item.index = i + 1;
		});

		return items;
	}

	/**
	 * Find the index of a sidenote in the document based on its text and approximate position.
	 */
	private findSidenoteIndex(
		sidenoteMap: { index: number; charPos: number; text: string }[],
		text: string,
		docPos: number | null,
	): number {
		const normalizedText = this.normalizeText(text);

		// Find all sidenotes with matching text
		const matchingByText = sidenoteMap.filter(
			(s) => s.text === normalizedText,
		);

		if (matchingByText.length === 1) {
			// Only one match - use it
			const match = matchingByText[0];
			if (match) {
				return match.index;
			}
		}

		if (matchingByText.length > 1 && docPos !== null) {
			// Multiple matches - find the closest by position
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
					closest = s;
					closestDist = dist;
				}
			}

			if (closest) {
				return closest.index;
			}
		}

		// Fallback: find any sidenote close to this position
		if (docPos !== null && sidenoteMap.length > 0) {
			const approxCharPos = Math.floor(docPos / 10000);
			let closest: {
				index: number;
				charPos: number;
				text: string;
			} | null = null;
			let closestDist = Infinity;

			for (const s of sidenoteMap) {
				const dist = Math.abs(s.charPos - approxCharPos);
				if (dist < closestDist) {
					closest = s;
					closestDist = dist;
				}
			}

			if (closest) {
				return closest.index;
			}
		}

		// Last resort - return 1
		return 1;
	}

	/**
	 * Remove all sidenote markup (wrappers and margins) so we can renumber from scratch.
	 * This unwraps the original span.sidenote elements and footnote ref spans.
	 */
	private removeAllSidenoteMarkup(root: HTMLElement) {
		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
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

	private normalizeText(s: string): string {
		return (s ?? "").replace(/\s+/g, " ").trim();
	}

	/**
	 * Render markdown-formatted text to a DocumentFragment.
	 * Supports: **bold**, *italic*, _italic_, `code`, [links](url), and [[wiki links]]
	 */
	private renderLinksToFragment(text: string): DocumentFragment {
		const frag = document.createDocumentFragment();

		// Combined regex for all supported formats:
		// - Bold: **text** or __text__
		// - Italic: *text* or _text_ (but not inside **)
		// - Code: `text`
		// - Markdown links: [text](url)
		// - Wiki links: [[target]] or [[target|display]]
		const combinedRe =
			/\*\*(.+?)\*\*|__(.+?)__|\*([^*]+?)\*|(?<![*_])_([^_]+?)_(?![*_])|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

		let last = 0;
		let m: RegExpExecArray | null;

		while ((m = combinedRe.exec(text)) !== null) {
			const start = m.index;
			const fullMatch = m[0];

			// Add text before the match
			if (start > last) {
				frag.appendChild(document.createTextNode(text.slice(last, start)));
			}

			if (m[1] !== undefined) {
				// Bold: **text**
				const strong = document.createElement("strong");
				strong.textContent = m[1];
				frag.appendChild(strong);
			} else if (m[2] !== undefined) {
				// Bold: __text__
				const strong = document.createElement("strong");
				strong.textContent = m[2];
				frag.appendChild(strong);
			} else if (m[3] !== undefined) {
				// Italic: *text*
				const em = document.createElement("em");
				em.textContent = m[3];
				frag.appendChild(em);
			} else if (m[4] !== undefined) {
				// Italic: _text_
				const em = document.createElement("em");
				em.textContent = m[4];
				frag.appendChild(em);
			} else if (m[5] !== undefined) {
				// Code: `text`
				const code = document.createElement("code");
				code.textContent = m[5];
				frag.appendChild(code);
			} else if (m[6] !== undefined && m[7] !== undefined) {
				// Markdown link: [text](url)
				const label = m[6];
				const url = m[7].trim();

				const isExternal =
					url.startsWith("http://") ||
					url.startsWith("https://") ||
					url.startsWith("mailto:");

				const a = document.createElement("a");
				a.textContent = label;

				if (isExternal) {
					a.href = url;
					a.className = "external-link";
					a.rel = "noopener noreferrer";
					a.target = "_blank";
				} else {
					// Treat as internal link
					a.className = "internal-link";
					a.setAttribute("data-href", url);
					a.addEventListener("click", (e) => {
						e.preventDefault();
						e.stopPropagation();
						void this.app.workspace.openLinkText(url, "", false);
					});
				}
				frag.appendChild(a);
			} else if (m[8] !== undefined) {
				// Wiki link: [[target]] or [[target|display]]
				const target = m[8].trim();
				const display = m[9]?.trim() || target;

				const a = document.createElement("a");
				a.textContent = display;
				a.className = "internal-link";
				a.setAttribute("data-href", target);
				a.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					void this.app.workspace.openLinkText(target, "", false);
				});
				frag.appendChild(a);
			}

			last = start + fullMatch.length;
		}

		// Add remaining text
		if (last < text.length) {
			frag.appendChild(document.createTextNode(text.slice(last)));
		}

		return frag;
	}

	/**
	 * Set up a click handler on the sidenote wrapper to select only the text content,
	 * not the HTML tags, when clicked in the editor.
	 */
	private setupSidenoteClickHandler(
		wrapper: HTMLElement,
		sidenoteIndex: number,
	) {
		wrapper.addEventListener("click", (e) => {
			// Only handle clicks on the sidenote span itself, not the margin
			const target = e.target as HTMLElement;
			if (target.closest(".sidenote-margin")) {
				return; // Let the margin editing handler deal with this
			}

			// Prevent default selection behavior
			e.preventDefault();
			e.stopPropagation();

			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view?.editor) return;

			const editor = view.editor;
			const content = editor.getValue();

			// Find the Nth sidenote in the source
			const sidenoteRegex =
				/<span\s+class\s*=\s*["']sidenote["'][^>]*>([\s\S]*?)<\/span>/gi;

			let match: RegExpExecArray | null;
			let currentIndex = 0;

			while ((match = sidenoteRegex.exec(content)) !== null) {
				currentIndex++;

				if (currentIndex === sidenoteIndex) {
					// Found our sidenote - calculate positions for just the text content
					const fullMatch = match[0];
					const textContent = match[1] ?? "";

					// Find where the text starts (after the opening tag)
					const openingTagEnd = fullMatch.indexOf(">") + 1;
					const textStart = match.index + openingTagEnd;
					const textEnd = textStart + textContent.length;

					// Convert to editor positions
					const from = editor.offsetToPos(textStart);
					const to = editor.offsetToPos(textEnd);

					// Set the selection to just the text content
					editor.setSelection(from, to);
					editor.focus();

					return;
				}
			}
		});
	}

	// ==================== Margin Editing ====================

	/**
	 * Set up a margin element to be editable in place.
	 * When clicked, it becomes editable. On blur, changes are saved to the source.
	 */
	private setupMarginEditing(
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
	private startMarginEdit(
		margin: HTMLElement,
		sourceSpan: HTMLElement,
		sidenoteIndex: number,
		clickEvent?: MouseEvent,
	) {
		// If already editing a span, don't re-init
		if (this.spanCmView) return;

		// Record original text for cancel
		this.spanOriginalText = sourceSpan.textContent ?? "";

		margin.dataset.editing = "true";
		margin.innerHTML = "";

		const commitAndClose = (opts: { commit: boolean }) => {
			const cmInner = this.spanCmView;
			if (!cmInner) return;

			const newText = cmInner.state.doc.toString();
			const renderText = opts.commit ? newText : this.spanOriginalText;

			if (this.spanOutsidePointerDown) {
				document.removeEventListener(
					"pointerdown",
					this.spanOutsidePointerDown,
					true,
				);
				this.spanOutsidePointerDown = undefined;
			}

			this.spanCmView = null;
			cmInner.destroy();

			margin.dataset.editing = "false";

			if (opts.commit && newText !== this.spanOriginalText) {
				this.commitHtmlSpanSidenoteText(sidenoteIndex, newText);
			}

			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(renderText)),
			);
		};

		// Keymap: ESC cancels; Enter commits; Shift-Enter inserts newline (optional)
		const closeKeymap = keymap.of([
			{
				key: "Escape",
				run: () => {
					commitAndClose({ commit: false });
					return true;
				},
				preventDefault: true,
			},
			{
				key: "Enter",
				run: () => {
					commitAndClose({ commit: true });
					return true;
				},
				preventDefault: true,
			},
			{
				key: "Shift-Enter",
				run: (view) => {
					view.dispatch(view.state.replaceSelection("\n"));
					return true;
				},
				preventDefault: true,
			},
		]);

		const state = EditorState.create({
			doc: this.spanOriginalText,
			extensions: [
				closeKeymap,
				sidenoteEditorTheme,
				history(),
				markdown(),
				syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				// Your markdown formatting hotkeys (Mod-b/i/k) if you added them:
				markdownEditHotkeys,
				// Keep standard CM key behavior (arrow keys, delete, etc.)
				keymap.of(historyKeymap),
				keymap.of(defaultKeymap),
				EditorView.lineWrapping,
			],
		});

		const cm = new EditorView({
			state,
			parent: margin,
		});

		cm.dom.addEventListener(
			"focusin",
			() => {
				setWorkspaceActiveEditor(this, cm);
			},
			true,
		);

		cm.dom.addEventListener(
			"focusout",
			() => {
				setWorkspaceActiveEditor(this, null);
			},
			true,
		);

		this.spanCmView = cm;
		cm.dom.classList.add("sidenote-cm-editor");
		const scroller = cm.dom.querySelector<HTMLElement>(".cm-scroller");
		if (scroller) {
			setCssProps(scroller, { "padding-left": "0", padding: "0" }, true);
		}

		// Click anywhere outside the margin editor => commit and close
		this.spanOutsidePointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (margin.contains(target) || cm.dom.contains(target)) return;

			commitAndClose({ commit: true });
		};
		document.addEventListener(
			"pointerdown",
			this.spanOutsidePointerDown,
			true,
		);

		requestAnimationFrame(() => cm.focus());
	}

	private commitHtmlSpanSidenoteText(
		sidenoteIndex: number,
		newText: string,
	) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.editor) return;

		const editor = view.editor;

		// Preserve scroll like your current finishMarginEdit does
		const scroller =
			this.cmRoot?.querySelector<HTMLElement>(".cm-scroller");
		const scrollTop = scroller?.scrollTop ?? 0;

		this.isEditingMargin = true;

		const content = editor.getValue();
		const sidenoteRegex =
			/<span\s+class\s*=\s*["']sidenote["'][^>]*>([\s\S]*?)<\/span>/gi;

		let match: RegExpExecArray | null;
		let currentIndex = 0;

		while ((match = sidenoteRegex.exec(content)) !== null) {
			currentIndex++;
			if (currentIndex === sidenoteIndex) {
				const from = editor.offsetToPos(match.index);
				const to = editor.offsetToPos(match.index + match[0].length);
				const newSpan = `<span class="sidenote">${newText}</span>`;

				this.isMutating = true;
				try {
					editor.replaceRange(newSpan, from, to);
				} finally {
					this.isMutating = false;
				}
				break;
			}
		}

		// Restore scroll
		if (scroller) scroller.scrollTop = scrollTop;

		this.isEditingMargin = false;
	}

	// ==================== Collision Avoidance ====================

	/**
	 * Core collision avoidance algorithm.
	 *
	 * Each margin is absolutely positioned to align with its anchor (the inline reference).
	 * With --sidenote-shift: 0px, the margin's top aligns with its anchor's top.
	 * We apply positive shifts to push margins down when they would overlap.
	 *
	 * @param margins - Array of margin elements to check for collisions
	 * @param spacing - Minimum pixels between stacked sidenotes
	 */
	private resolveCollisions(margins: HTMLElement[], spacing: number) {
		if (!margins || margins.length === 0) return;

		// Filter to only connected, visible margins
		const validMargins = margins.filter(
			(m) => m.isConnected && m.offsetHeight > 0,
		);

		if (validMargins.length === 0) return;

		// Step 1: Reset all shifts to measure natural/anchor positions
		for (const margin of validMargins) {
			setCssProps(margin, { "--sidenote-shift": "0px" });
		}

		// Step 2: Force synchronous reflow to get accurate measurements
		void document.body.offsetHeight;

		// Step 3: Measure each margin at its natural position (shift=0)
		const items: {
			el: HTMLElement;
			anchorY: number; // Top position when shift=0 (aligned with anchor)
			height: number;
			shift: number; // Shift to apply (will be calculated)
		}[] = [];

		for (const margin of validMargins) {
			const rect = margin.getBoundingClientRect();
			if (rect.height <= 0) continue;

			items.push({
				el: margin,
				anchorY: rect.top,
				height: rect.height,
				shift: 0,
			});
		}

		if (items.length === 0) return;

		// Step 4: Sort by anchor position (document order)
		items.sort((a, b) => a.anchorY - b.anchorY);

		// Step 5: Greedily assign positions to avoid collisions
		// Track where the next available vertical position is
		let nextFreeY = -Infinity;

		for (const item of items) {
			// This margin wants to be at anchorY
			// But it cannot start above nextFreeY
			const targetY = Math.max(item.anchorY, nextFreeY);

			// The shift is how far from anchorY we need to move
			item.shift = targetY - item.anchorY;

			// Update nextFreeY to be after this margin
			nextFreeY = targetY + item.height + spacing;
		}

		// Step 6: Apply the calculated shifts
		for (const item of items) {
			if (item.shift > 0.5) {
				item.el.style.setProperty("--sidenote-shift", `${item.shift}px`);
			} else {
				item.el.style.setProperty("--sidenote-shift", `${0}px`);
			}
		}
	}
	/**
	 * Schedule collision resolution for editing mode.
	 */
	private scheduleCollisionUpdate() {
		if (this.rafId !== null) return;

		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.updateEditingModeCollisions();
		});
	}

	/**
	 * Update collisions in editing mode (source view).
	 */
	private updateEditingModeCollisions() {
		if (!this.cmRoot) return;

		const margins = Array.from(
			this.cmRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);

		this.resolveCollisions(margins, this.settings.collisionSpacing);
	}

	/**
	 * Update collisions in reading mode.
	 */
	private updateReadingModeCollisions() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (!readingRoot) return;

		const margins = Array.from(
			readingRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);

		this.resolveCollisions(margins, this.settings.collisionSpacing);
	}

	/**
	 * Run collision avoidance specifically for reading mode sidenotes.
	 * This is called after processing sidenotes in reading mode.
	 */
	private avoidCollisionsInReadingMode(readingRoot: HTMLElement) {
		if (!readingRoot?.isConnected) return;

		const margins = Array.from(
			readingRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);

		this.resolveCollisions(margins, this.settings.collisionSpacing);
	}

	/**
	 * Apply markdown formatting to the current selection or cursor position in a contenteditable element.
	 * @param element The contenteditable element
	 * @param prefix The prefix to add (e.g., "**" for bold, "*" for italic)
	 * @param suffix The suffix to add (defaults to prefix)
	 * @param linkMode If true, handle as a link with [text](url) format
	 */
	private applyMarkdownFormatting(
		element: HTMLElement,
		prefix: string,
		suffix: string = prefix,
		linkMode: boolean = false,
	) {
		// Ensure focus is on the element
		element.focus();

		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;

		const range = selection.getRangeAt(0);

		// Check if selection is within the element
		if (
			!element.contains(range.startContainer) ||
			!element.contains(range.endContainer)
		) {
			// Selection is outside - just insert at end of element
			const textContent = element.textContent || "";
			if (linkMode) {
				element.textContent = textContent + "[link text](url)";
			} else {
				element.textContent = textContent + prefix + suffix;
			}
			// Place cursor appropriately
			const newRange = document.createRange();
			const textNode = element.firstChild || element;
			const pos = textContent.length + prefix.length;
			try {
				newRange.setStart(textNode, pos);
				newRange.setEnd(textNode, pos);
				selection.removeAllRanges();
				selection.addRange(newRange);
			} catch (e) {
				console.error("Error setting cursor position:", e);
				// Ignore
			}
			return;
		}

		const selectedText = range.toString();

		// Get the text content and cursor positions relative to the element's text
		const fullText = element.textContent || "";

		// Calculate the start offset within the full text
		let startOffset = 0;
		let endOffset = 0;

		// Walk through text nodes to find the actual offsets
		const walker = document.createTreeWalker(
			element,
			NodeFilter.SHOW_TEXT,
			null,
		);
		let currentOffset = 0;
		let foundStart = false;
		let foundEnd = false;
		let node: Text | null;

		while ((node = walker.nextNode() as Text | null)) {
			const nodeLength = node.textContent?.length || 0;

			if (!foundStart && node === range.startContainer) {
				startOffset = currentOffset + range.startOffset;
				foundStart = true;
			}
			if (!foundEnd && node === range.endContainer) {
				endOffset = currentOffset + range.endOffset;
				foundEnd = true;
			}

			if (foundStart && foundEnd) break;
			currentOffset += nodeLength;
		}

		// Handle case where container is the element itself
		if (!foundStart && range.startContainer === element) {
			startOffset = 0;
			for (
				let i = 0;
				i < range.startOffset && i < element.childNodes.length;
				i++
			) {
				startOffset += element.childNodes[i]?.textContent?.length ?? 0;
			}
		}
		if (!foundEnd && range.endContainer === element) {
			endOffset = 0;
			for (
				let i = 0;
				i < range.endOffset && i < element.childNodes.length;
				i++
			) {
				endOffset += element.childNodes[i]?.textContent?.length ?? 0;
			}
		}

		// Build the new text
		let newText: string;
		let newCursorStart: number;
		let newCursorEnd: number;

		if (linkMode) {
			const linkText = selectedText || "link text";
			const replacement = `[${linkText}](url)`;
			newText =
				fullText.slice(0, startOffset) +
				replacement +
				fullText.slice(endOffset);
			// Select "url"
			newCursorStart = startOffset + 1 + linkText.length + 2; // [linkText](
			newCursorEnd = newCursorStart + 3; // url
		} else if (selectedText) {
			// Wrap selection
			const replacement = `${prefix}${selectedText}${suffix}`;
			newText =
				fullText.slice(0, startOffset) +
				replacement +
				fullText.slice(endOffset);
			// Select the wrapped text
			newCursorStart = startOffset + prefix.length;
			newCursorEnd = newCursorStart + selectedText.length;
		} else {
			// Insert at cursor
			newText =
				fullText.slice(0, startOffset) +
				prefix +
				suffix +
				fullText.slice(endOffset);
			// Place cursor between prefix and suffix
			newCursorStart = startOffset + prefix.length;
			newCursorEnd = newCursorStart;
		}

		// Update the element
		element.textContent = newText;

		// Restore cursor position
		requestAnimationFrame(() => {
			element.focus();
			const sel = window.getSelection();
			if (!sel) return;

			const textNode = element.firstChild;
			if (!textNode) return;

			try {
				const newRange = document.createRange();
				newRange.setStart(
					textNode,
					Math.min(newCursorStart, newText.length),
				);
				newRange.setEnd(textNode, Math.min(newCursorEnd, newText.length));
				sel.removeAllRanges();
				sel.addRange(newRange);
			} catch (e) {
				// Fallback - place at end
				console.error("Error setting cursor position:", e);
				const fallbackRange = document.createRange();
				fallbackRange.selectNodeContents(element);
				fallbackRange.collapse(false);
				sel.removeAllRanges();
				sel.addRange(fallbackRange);
			}
		});
	}

	/**
	 * Public version for widget to use.
	 */
	public applyMarkdownFormattingPublic(
		element: HTMLElement,
		prefix: string,
		suffix: string = prefix,
		linkMode: boolean = false,
	) {
		this.applyMarkdownFormatting(element, prefix, suffix, linkMode);
	}

	/**
	 * Insert markdown wrapper (like ** for bold, * for italic) around the
	 * current selection in a contentEditable element, or at cursor if no selection.
	 * Uses manual text manipulation to maintain plain-text editing.
	 */
	private insertMarkdownWrapper(element: HTMLElement, wrapper: string) {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;

		const range = selection.getRangeAt(0);
		if (
			!element.contains(range.startContainer) ||
			!element.contains(range.endContainer)
		)
			return;

		const fullText = element.textContent || "";

		// Calculate offsets within the full text
		const offsets = this.getSelectionOffsets(element, range);
		if (!offsets) return;

		const { start, end } = offsets;
		const selectedText = fullText.slice(start, end);

		let newText: string;
		let cursorStart: number;
		let cursorEnd: number;

		if (selectedText) {
			// Wrap selection
			newText =
				fullText.slice(0, start) +
				wrapper +
				selectedText +
				wrapper +
				fullText.slice(end);
			cursorStart = start + wrapper.length;
			cursorEnd = cursorStart + selectedText.length;
		} else {
			// Insert wrapper pair at cursor
			newText =
				fullText.slice(0, start) + wrapper + wrapper + fullText.slice(end);
			cursorStart = start + wrapper.length;
			cursorEnd = cursorStart;
		}

		element.textContent = newText;

		// Restore cursor
		requestAnimationFrame(() => {
			element.focus();
			const sel = window.getSelection();
			if (!sel || !element.firstChild) return;
			try {
				const newRange = document.createRange();
				newRange.setStart(
					element.firstChild,
					Math.min(cursorStart, newText.length),
				);
				newRange.setEnd(
					element.firstChild,
					Math.min(cursorEnd, newText.length),
				);
				sel.removeAllRanges();
				sel.addRange(newRange);
			} catch (e) {
				// Fallback
				console.error("Sidenotes - Error setting cursor position:", e);
			}
		});
	}

	/**
	 * Insert a markdown link at the current cursor/selection in a contentEditable element.
	 */
	private insertMarkdownLink(element: HTMLElement) {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;

		const range = selection.getRangeAt(0);
		if (
			!element.contains(range.startContainer) ||
			!element.contains(range.endContainer)
		)
			return;

		const fullText = element.textContent || "";
		const offsets = this.getSelectionOffsets(element, range);
		if (!offsets) return;

		const { start, end } = offsets;
		const selectedText = fullText.slice(start, end);

		const linkText = selectedText || "link text";
		const replacement = `[${linkText}](url)`;

		const newText =
			fullText.slice(0, start) + replacement + fullText.slice(end);

		// Position cursor to select "url"
		const urlStart = start + 1 + linkText.length + 2; // [linkText](
		const urlEnd = urlStart + 3; // url

		element.textContent = newText;

		requestAnimationFrame(() => {
			element.focus();
			const sel = window.getSelection();
			if (!sel || !element.firstChild) return;
			try {
				const newRange = document.createRange();
				newRange.setStart(
					element.firstChild,
					Math.min(urlStart, newText.length),
				);
				newRange.setEnd(
					element.firstChild,
					Math.min(urlEnd, newText.length),
				);
				sel.removeAllRanges();
				sel.addRange(newRange);
			} catch (e) {
				console.error("Sidenotes - Error setting cursor position:", e);
				// Fallback
			}
		});
	}

	/**
	 * Get the start and end character offsets of the current selection
	 * within a contentEditable element's text content.
	 */
	private getSelectionOffsets(
		element: HTMLElement,
		range: Range,
	): { start: number; end: number } | null {
		const walker = document.createTreeWalker(
			element,
			NodeFilter.SHOW_TEXT,
			null,
		);
		let currentOffset = 0;
		let startOffset = 0;
		let endOffset = 0;
		let foundStart = false;
		let foundEnd = false;
		let node: Text | null;

		while ((node = walker.nextNode() as Text | null)) {
			const nodeLength = node.textContent?.length || 0;

			if (!foundStart && node === range.startContainer) {
				startOffset = currentOffset + range.startOffset;
				foundStart = true;
			}
			if (!foundEnd && node === range.endContainer) {
				endOffset = currentOffset + range.endOffset;
				foundEnd = true;
			}

			if (foundStart && foundEnd) break;
			currentOffset += nodeLength;
		}

		// Handle case where container is the element itself
		if (!foundStart && range.startContainer === element) {
			startOffset = 0;
			for (
				let i = 0;
				i < range.startOffset && i < element.childNodes.length;
				i++
			) {
				startOffset += element.childNodes[i]?.textContent?.length ?? 0;
			}
			foundStart = true;
		}
		if (!foundEnd && range.endContainer === element) {
			endOffset = 0;
			for (
				let i = 0;
				i < range.endOffset && i < element.childNodes.length;
				i++
			) {
				endOffset += element.childNodes[i]?.textContent?.length ?? 0;
			}
			foundEnd = true;
		}

		if (!foundStart || !foundEnd) return null;
		return { start: startOffset, end: endOffset };
	}

	/**
	 * Set up keyboard interception that prevents CM6 from seeing ANY key events
	 * while a margin is being edited.
	 *
	 * We attach a capture-phase listener on the .cm-editor element itself
	 * and call stopImmediatePropagation to prevent CM6's own handlers from firing.
	 * We also attach on document as a fallback for reading mode (where there's no CM6).
	 *
	 * Returns a cleanup function.
	 */
	private setupMarginKeyboardCapture(margin: HTMLElement): () => void {
		this.setCurrentlyEditingMargin(margin);

		const handler = (e: KeyboardEvent) => {
			if (margin.contentEditable !== "true") return;
			if (
				document.activeElement !== margin &&
				!margin.contains(document.activeElement)
			)
				return;

			const isMod = e.metaKey || e.ctrlKey;

			if (e.key === "Escape") {
				e.preventDefault();
				e.stopImmediatePropagation();
				margin.dataset.cancelled = "true";
				margin.blur();
				return;
			}

			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				e.stopImmediatePropagation();
				margin.blur();
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "b" &&
				!e.shiftKey &&
				!e.altKey
			) {
				// console.warn("BOLD shortcut detected");
				e.preventDefault();
				e.stopImmediatePropagation();
				this.insertMarkdownWrapper(margin, "**");
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "i" &&
				!e.shiftKey &&
				!e.altKey
			) {
				// console.warn("ITALICS shortcut detected");
				e.preventDefault();
				e.stopImmediatePropagation();
				this.insertMarkdownWrapper(margin, "*");
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "k" &&
				!e.shiftKey &&
				!e.altKey
			) {
				e.preventDefault();
				e.stopImmediatePropagation();
				this.insertMarkdownLink(margin);
				return;
			}

			if (
				isMod &&
				e.key.toLowerCase() === "a" &&
				!e.shiftKey &&
				!e.altKey
			) {
				e.preventDefault();
				e.stopImmediatePropagation();
				const selection = window.getSelection();
				const range = document.createRange();
				range.selectNodeContents(margin);
				selection?.removeAllRanges();
				selection?.addRange(range);
				return;
			}

			if (isMod && e.key.toLowerCase() === "z") {
				e.stopImmediatePropagation();
				return;
			}

			if (
				["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
			) {
				e.stopImmediatePropagation();

				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) return;
				const range = selection.getRangeAt(0);

				const atStart =
					range.collapsed &&
					range.startOffset === 0 &&
					(range.startContainer === margin ||
						range.startContainer === margin.firstChild);

				let atEnd = false;
				if (range.collapsed) {
					if (range.startContainer === margin) {
						atEnd = range.startOffset === margin.childNodes.length;
					} else if (range.startContainer.nodeType === Node.TEXT_NODE) {
						const len = range.startContainer.textContent?.length ?? 0;
						atEnd =
							range.startOffset === len &&
							(range.startContainer === margin.lastChild ||
								range.startContainer.parentNode === margin);
					}
				}

				if (atStart && e.key === "ArrowLeft") {
					e.preventDefault();
					return;
				}
				if (atEnd && e.key === "ArrowRight") {
					e.preventDefault();
					return;
				}

				if (e.key === "ArrowUp" || e.key === "ArrowDown") {
					const cursorRect = range.getBoundingClientRect();
					const marginRect = margin.getBoundingClientRect();
					const lh = parseFloat(getComputedStyle(margin).lineHeight) || 20;
					if (
						e.key === "ArrowUp" &&
						cursorRect.top - marginRect.top < lh
					) {
						e.preventDefault();
						return;
					}
					if (
						e.key === "ArrowDown" &&
						marginRect.bottom - cursorRect.bottom < lh
					) {
						e.preventDefault();
						return;
					}
				}
				return;
			}

			// Block ALL other keys from reaching Obsidian/CM6
			e.stopImmediatePropagation();
		};

		// CRITICAL: Attach to window (not document, not cm-editor) in capture phase.
		// Capture flows: window → document → ... → element.
		// Obsidian's hotkey system registers on document, so window fires first.
		window.addEventListener("keydown", handler, true);

		return () => {
			window.removeEventListener("keydown", handler, true);
			this.setCurrentlyEditingMargin(null);
		};
	}

	public setupMarginKeyboardCapturePublic(
		margin: HTMLElement,
	): () => void {
		return this.setupMarginKeyboardCapture(margin);
	}
}

// ======================================================
// ==================== Settings Tab ====================
// ======================================================

class SidenoteSettingTab extends PluginSettingTab {
	plugin: SidenotePlugin;

	constructor(app: App, plugin: SidenotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Sidenote Format").setHeading();

		new Setting(containerEl)
			.setName("Sidenote format")
			.setDesc("Choose how sidenotes are written in your documents")
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						"html",
						'HTML spans: <span class="sidenote">text</span>',
					)
					//.addOption("footnote", "Footnotes (reading mode only)")
					.addOption(
						"footnote-edit",
						"Footnotes (reading + editing mode) [experimental]",
					)
					.setValue(this.plugin.settings.sidenoteFormat)
					.onChange(async (value: "html" | "footnote-edit") => {
						this.plugin.settings.sidenoteFormat = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("If using Footnotes").setHeading();

		new Setting(containerEl)
			.setName("Hide footnotes")
			.setDesc(
				"Hides the footnotes at the bottom of the document (only relevant if using footnote format)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideFootnotes)
					.onChange(async (value) => {
						this.plugin.settings.hideFootnotes = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Hide footnote numbers in text")
			.setDesc(
				"Hides the Markdown style footnote reference numbers in the text body, and replaces with sidenote numbers only (only relevant if using footnote format)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideFootnoteNumbers)
					.onChange(async (value) => {
						this.plugin.settings.hideFootnoteNumbers = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Display").setHeading();

		new Setting(containerEl)
			.setName("Sidenote position")
			.setDesc(
				"Which margin to display sidenotes in (text will be offset to the opposite side)",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("left", "Left margin")
					.addOption("right", "Right margin")
					.setValue(this.plugin.settings.sidenotePosition)
					.onChange(async (value: "left" | "right") => {
						this.plugin.settings.sidenotePosition = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show sidenote numbers")
			.setDesc("Display reference numbers in text and sidenotes")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showSidenoteNumbers)
					.onChange(async (value) => {
						this.plugin.settings.showSidenoteNumbers = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Number style")
			.setDesc("How to format sidenote numbers")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("arabic", "Arabic (1, 2, 3)")
					.addOption("roman", "Roman (i, ii, iii)")
					.addOption("letters", "Letters (a, b, c)")
					.setValue(this.plugin.settings.numberStyle)
					.onChange(async (value: "arabic" | "roman" | "letters") => {
						this.plugin.settings.numberStyle = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Number badge style")
			.setDesc("Visual style for sidenote numbers")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("plain", "Plain (superscript)")
					.addOption("neumorphic", "Neumorphic (subtle badge)")
					.addOption("pill", "Pill (colored capsule)")
					.setValue(this.plugin.settings.numberBadgeStyle)
					.onChange(async (value: "plain" | "neumorphic" | "pill") => {
						this.plugin.settings.numberBadgeStyle = value;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Number color")
			.setDesc(
				"Custom color for sidenote numbers (leave empty for theme default)",
			)
			.addText((text) =>
				text
					.setPlaceholder("#666666 or rgb(100,100,100)")
					.setValue(this.plugin.settings.numberColor)
					.onChange(async (value) => {
						this.plugin.settings.numberColor = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Width & Spacing").setHeading();

		new Setting(containerEl)
			.setName("Sidenote anchor")
			.setDesc(
				"Whether sidenotes are positioned relative to the text body or the editor edge",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("text", "Anchor to text (traditional)")
					.addOption("edge", "Anchor to editor edge")
					.setValue(this.plugin.settings.sidenoteAnchor)
					.onChange(async (value: "text" | "edge") => {
						this.plugin.settings.sidenoteAnchor = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Minimum sidenote width")
			.setDesc("Base width of sidenotes in rem (default: 10)")
			.addSlider((slider) =>
				slider
					.setLimits(5, 25, 1)
					.setValue(this.plugin.settings.minSidenoteWidth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.minSidenoteWidth = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Maximum sidenote width")
			.setDesc("Maximum width of sidenotes in rem (default: 18)")
			.addSlider((slider) =>
				slider
					.setLimits(10, 40, 1)
					.setValue(this.plugin.settings.maxSidenoteWidth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxSidenoteWidth = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Minimum Gap between sidenote and text")
			.setDesc(
				"Space between the margin and body text in rem (default: 2)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 30, 0.5)
					.setValue(this.plugin.settings.sidenoteGap)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.sidenoteGap = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Minimum gap between sidenote and editor edge")
			.setDesc(
				"When anchored to text: minimum distance from editor edge. When anchored to edge: minimum distance from text body. (rem, default: 1)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 10, 0.5)
					.setValue(this.plugin.settings.sidenoteGap2)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.sidenoteGap2 = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Page Offset Factor")
			.setDesc(
				"Adjusts how much body text gets nudged over when sidenotes are present (default: 0)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.1)
					.setValue(this.plugin.settings.pageOffsetFactor)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.pageOffsetFactor = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Breakpoints").setHeading();

		new Setting(containerEl)
			.setName("Hide below width")
			.setDesc("Hide sidenotes when editor width is below this (px)")
			.addText((text) =>
				text
					.setPlaceholder("700")
					.setValue(String(this.plugin.settings.hideBelow))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.hideBelow = num;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Compact below width")
			.setDesc("Use compact mode when editor width is below this (px)")
			.addText((text) =>
				text
					.setPlaceholder("900")
					.setValue(String(this.plugin.settings.compactBelow))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.compactBelow = num;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Full width above")
			.setDesc(
				"Use full-width sidenotes when editor width is above this (px)",
			)
			.addText((text) =>
				text
					.setPlaceholder("1400")
					.setValue(String(this.plugin.settings.fullAbove))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.fullAbove = num;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl).setName("Typography").setHeading();

		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Font size as percentage of body text (default: 80)")
			.addSlider((slider) =>
				slider
					.setLimits(50, 100, 5)
					.setValue(this.plugin.settings.fontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.fontSize = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Font size (compact mode)")
			.setDesc("Font size in compact mode as percentage (default: 70)")
			.addSlider((slider) =>
				slider
					.setLimits(50, 100, 5)
					.setValue(this.plugin.settings.fontSizeCompact)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.fontSizeCompact = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Line height")
			.setDesc("Line height for sidenote text (default: 1.35)")
			.addSlider((slider) =>
				slider
					.setLimits(1, 2, 0.05)
					.setValue(this.plugin.settings.lineHeight)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.lineHeight = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Text alignment")
			.setDesc("How to align text in sidenotes")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("left", "Left")
					.addOption("right", "Right")
					.addOption("justify", "Justified")
					.setValue(this.plugin.settings.textAlignment)
					.onChange(async (value: "left" | "right" | "justify") => {
						this.plugin.settings.textAlignment = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Behavior").setHeading();

		new Setting(containerEl)
			.setName("Collision spacing")
			.setDesc("Minimum pixels between stacked sidenotes (default: 8)")
			.addSlider((slider) =>
				slider
					.setLimits(0, 20, 1)
					.setValue(this.plugin.settings.collisionSpacing)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.collisionSpacing = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Enable smooth transitions")
			.setDesc("Animate width and position changes")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableTransitions)
					.onChange(async (value) => {
						this.plugin.settings.enableTransitions = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Reset numbering per heading")
			.setDesc("Restart sidenote numbering after each heading")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.resetNumberingPerHeading)
					.onChange(async (value) => {
						this.plugin.settings.resetNumberingPerHeading = value;
						await this.plugin.saveSettings();
					}),
			);

		// Help section
		new Setting(containerEl).setName("Formatting Help").setHeading();

		const helpDiv = containerEl.createDiv({ cls: "sidenote-help" });
		helpDiv.innerHTML = `
            <p>Sidenotes support basic Markdown formatting:</p>
            <ul>
                <li><code>**bold**</code> or <code>__bold__</code> → <strong>bold</strong></li>
                <li><code>*italic*</code> or <code>_italic_</code> → <em>italic</em></li>
                <li><code>\`code\`</code> → <code>code</code></li>
                <li><code>[link](url)</code> → clickable link</li>
                <li><code>[[Note]]</code> or <code>[[Note|display]]</code> → internal link</li>
            </ul>
            <p>Use the command palette to insert sidenotes quickly.</p>
        `;
	}
}

function setCssProps(
	el: HTMLElement,
	props: Record<string, string>,
	important: boolean = false,
) {
	for (const [key, value] of Object.entries(props)) {
		el.style.setProperty(key, value, important ? "important" : "");
	}
}

function cmToPos(view: EditorView, offset: number): EditorPosition {
	const line = view.state.doc.lineAt(offset);
	return { line: line.number - 1, ch: offset - line.from };
}

function posToCm(view: EditorView, pos: EditorPosition): number {
	const line = view.state.doc.line(pos.line + 1);
	return Math.max(line.from, Math.min(line.to, line.from + pos.ch));
}

export function cmEditorAdapter(view: EditorView): MinimalEditor {
	return {
		getValue() {
			return view.state.doc.toString();
		},

		getLine(line: number) {
			return view.state.doc.line(line + 1).text;
		},

		lineCount() {
			return view.state.doc.lines;
		},

		getCursor() {
			return cmToPos(view, view.state.selection.main.head);
		},

		setCursor(pos: EditorPosition) {
			const off = posToCm(view, pos);
			view.dispatch({ selection: { anchor: off } });
		},

		setSelection(anchor: EditorPosition, head?: EditorPosition) {
			const a = posToCm(view, anchor);
			const h = posToCm(view, head ?? anchor);
			view.dispatch({ selection: { anchor: a, head: h } });
		},

		getSelection() {
			const sel = view.state.selection.main;
			return view.state.sliceDoc(sel.from, sel.to);
		},

		replaceSelection(text: string) {
			const sel = view.state.selection.main;
			view.dispatch({
				changes: { from: sel.from, to: sel.to, insert: text },
			});
		},

		getRange(from: EditorPosition, to: EditorPosition) {
			const a = posToCm(view, from);
			const b = posToCm(view, to);
			return view.state.sliceDoc(Math.min(a, b), Math.max(a, b));
		},

		replaceRange(text: string, from: EditorPosition, to?: EditorPosition) {
			const a = posToCm(view, from);
			const b = posToCm(view, to ?? from);
			view.dispatch({
				changes: {
					from: Math.min(a, b),
					to: Math.max(a, b),
					insert: text,
				},
			});
		},
	};
}

function setWorkspaceActiveEditor(
	plugin: SidenotePlugin,
	view: EditorView | null,
) {
	const ws: any = plugin.app.workspace;
	if (!view) {
		ws.activeEditor = null;
		return;
	}

	ws.activeEditor = {
		editor: cmEditorAdapter(view),
		file: plugin.app.workspace.getActiveFile(),
	};
}

function wrapSelection(view: EditorView, left: string, right: string) {
	const changes: { from: number; to: number; insert: string }[] = [];
	const ranges: { anchor: number; head: number }[] = [];

	for (const range of view.state.selection.ranges) {
		const from = Math.min(range.from, range.to);
		const to = Math.max(range.from, range.to);
		const selected = view.state.sliceDoc(from, to);

		const insert = left + selected + right;
		changes.push({ from, to, insert });

		// place cursor inside markers when no selection; otherwise keep selection
		if (from === to) {
			const cursor = from + left.length;
			ranges.push({ anchor: cursor, head: cursor });
		} else {
			ranges.push({
				anchor: from + left.length,
				head: to + left.length,
			});
		}
	}

	view.dispatch({
		changes,
		selection: EditorSelection.create(
			ranges.map((r) => EditorSelection.range(r.anchor, r.head)),
		),
		userEvent: "input",
	});
}

const mdBold: Command = (view) => {
	wrapSelection(view, "**", "**");
	return true;
};

const mdItalic: Command = (view) => {
	wrapSelection(view, "*", "*");
	return true;
};

const mdLink: Command = (view) => {
	// If selection: [text]()
	// If none: []() and cursor inside []
	const changes: { from: number; to: number; insert: string }[] = [];
	const ranges: { anchor: number; head: number }[] = [];

	for (const range of view.state.selection.ranges) {
		const from = Math.min(range.from, range.to);
		const to = Math.max(range.from, range.to);
		const selected = view.state.sliceDoc(from, to);

		const insert = `[${selected}]()`;
		changes.push({ from, to, insert });

		if (from === to) {
			// cursor between [ ]
			const cursor = from + 1;
			ranges.push({ anchor: cursor, head: cursor });
		} else {
			// keep selection on the text inside []
			ranges.push({
				anchor: from + 1,
				head: from + 1 + selected.length,
			});
		}
	}

	view.dispatch({
		changes,
		selection: EditorSelection.create(
			ranges.map((r) => EditorSelection.range(r.anchor, r.head)),
		),
		userEvent: "input",
	});

	return true;
};

const markdownEditHotkeys = keymap.of([
	{ key: "Mod-b", run: mdBold, preventDefault: true },
	{ key: "Mod-i", run: mdItalic, preventDefault: true },
	{ key: "Mod-k", run: mdLink, preventDefault: true },
]);

const sidenoteEditorTheme = EditorView.theme({
	"&": {
		backgroundColor: "transparent !important",
		color: "inherit !important",
		padding: "0 !important",
		margin: "0 !important",
		border: "none !important",
		height: "auto !important",
		minHeight: "0 !important",
	},
	"& .cm-scroller": {
		padding: "0 !important",
		paddingLeft: "0 !important",
		paddingRight: "0 !important",
		margin: "0 !important",
		overflow: "visible !important",
		height: "auto !important",
		minHeight: "0 !important",
	},
	"& .cm-content": {
		padding: "2px 0 !important",
		paddingLeft: "0 !important",
		margin: "0 !important",
		minHeight: "auto !important",
	},
	"& .cm-content[contenteditable]": {
		padding: "2px 0 !important",
		paddingLeft: "0 !important",
	},
	"& .cm-line": {
		padding: "0 !important",
		paddingLeft: "0 !important",
		margin: "0 !important",
	},
	"& .cm-gutters": {
		display: "none !important",
		width: "0 !important",
		minWidth: "0 !important",
		border: "none !important",
	},
	"& .cm-cursor": {
		borderLeftColor: "var(--text-normal) !important",
	},
	"&.cm-focused": {
		outline: "none !important",
	},
	"&.cm-focused .cm-cursor": {
		borderLeftColor: "var(--text-normal) !important",
	},
	"& .cm-activeLineGutter": {
		backgroundColor: "transparent !important",
		display: "none !important",
	},
	"& .cm-activeLine": {
		backgroundColor: "transparent !important",
	},
});

// ======================================================
// ========CodeMirror 6 Footnote Sidenote Widget ========
// ======================================================
/**
 * Widget that displays a footnote as a sidenote in the margin.
 */
class FootnoteSidenoteWidget extends WidgetType {
	constructor(
		readonly content: string,
		readonly numberText: string,
		readonly footnoteId: string,
		readonly plugin: SidenotePlugin,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const wrapper = document.createElement("span");
		wrapper.className = "sidenote-number";
		wrapper.dataset.sidenoteNum = this.numberText;
		wrapper.dataset.footnoteId = this.footnoteId;

		const margin = document.createElement("small");
		margin.className = "sidenote-margin";
		margin.dataset.sidenoteNum = this.numberText;
		margin.style.setProperty("--sidenote-shift", "0px");
		margin.style.setProperty("--sidenote-line-offset", "0px");

		// Render the content with markdown formatting support
		const fragment = this.plugin.renderLinksToFragmentPublic(
			this.plugin.normalizeTextPublic(this.content),
		);
		margin.appendChild(fragment);

		// Set up editing for the margin
		this.setupMarginEditing(margin);

		wrapper.appendChild(margin);

		// Add click handler on wrapper (the number badge) to trigger margin editing
		wrapper.addEventListener("click", (e) => {
			// Don't trigger if clicking directly on the margin (it has its own handler)
			if ((e.target as HTMLElement).closest(".sidenote-margin")) {
				return;
			}

			// Don't trigger if margin is already being edited
			if (margin.contentEditable === "true") {
				return;
			}

			e.preventDefault();
			e.stopPropagation();

			this.startMarginEdit(margin);
		});

		// Prevent mousedown from propagating to CM6 editor
		wrapper.addEventListener("mousedown", (e) => {
			if ((e.target as HTMLElement).closest(".sidenote-margin")) {
				// If margin is being edited, allow normal behavior
				if (margin.contentEditable === "true") {
					return;
				}
			}
			e.stopPropagation();
		});

		// After the widget is attached to the DOM, calculate line offset and trigger collision avoidance
		requestAnimationFrame(() => {
			if (wrapper.isConnected) {
				// Calculate line offset within the .cm-line
				const line = wrapper.closest(".cm-line") as HTMLElement | null;
				if (line) {
					const wrapperRect = wrapper.getBoundingClientRect();
					const lineRect = line.getBoundingClientRect();
					const lineOffset = wrapperRect.top - lineRect.top;
					margin.style.setProperty(
						"--sidenote-line-offset",
						`${lineOffset}px`,
					);
				}

				this.plugin.scheduleEditingModeCollisionUpdate();
			}
		});

		return wrapper;
	}

	private cmView: EditorView | null = null;
	private outsidePointerDown?: (ev: PointerEvent) => void;
	private originalText: string = "";

	private setActiveEditorForMargin(cm: EditorView | null) {
		(this.plugin.app.workspace as any).activeEditor = cm
			? {
					editor: cmEditorAdapter(cm),
					file: this.plugin.app.workspace.getActiveFile(),
				}
			: null;
	}

	private makeCommitKeymap(margin: HTMLElement) {
		return keymap.of([
			{
				key: "Enter",
				run: () => {
					this.closeMarginEditor(margin, { commit: true });
					return true; // handled
				},
				preventDefault: true,
			},
			{
				key: "Shift-Enter",
				run: (view) => {
					// Allow newline insertion
					view.dispatch(view.state.replaceSelection("\n"));
					return true;
				},
				preventDefault: true,
			},
		]);
	}

	private closeMarginEditor(
		margin: HTMLElement,
		opts: { commit: boolean },
	) {
		const cm = this.cmView;
		if (!cm) return;

		// Restore the number attribute
		margin.dataset.sidenoteNum = this.numberText;
		margin.dataset.editing = "false";

		const newText = cm.state.doc.toString();
		const textToUse = opts.commit ? newText : this.originalText;

		// cleanup listeners
		if (this.outsidePointerDown) {
			document.removeEventListener(
				"pointerdown",
				this.outsidePointerDown,
				true,
			);
			this.outsidePointerDown = undefined;
		}

		// destroy CM first
		this.cmView = null;
		cm.destroy();

		// restore routing + state
		this.setActiveEditorForMargin(null);
		this.plugin.setActiveFootnoteEdit(null);
		margin.dataset.editing = "false";

		// If committing, write back to footnote definition in the note.
		// If canceling, just re-render original.
		if (opts.commit && textToUse !== this.content) {
			this.commitFootnoteText(textToUse);
		}

		// Re-render the sidenote display view
		margin.innerHTML = "";
		margin.appendChild(
			this.plugin.renderLinksToFragmentPublic(
				this.plugin.normalizeTextPublic(this.content),
			),
		);
	}

	private commitFootnoteText(newText: string) {
		const view =
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.editor) return;

		const editor = view.editor;
		const content = editor.getValue();

		const escapedId = this.footnoteId.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);
		const footnoteDefRegex = new RegExp(
			`^(\\[\\^${escapedId}\\]:\\s*)(.+(?:\\n(?:[ \\t]+.+)*)?)$`,
			"gm",
		);

		const match = footnoteDefRegex.exec(content);
		if (!match) return;

		const prefix = match[1] ?? "";
		const from = editor.offsetToPos(match.index + prefix.length);
		const to = editor.offsetToPos(match.index + match[0].length);

		editor.replaceRange(newText, from, to);
	}

	private setupMarginEditing(margin: HTMLElement) {
		margin.dataset.editing = "false";

		const onMouseDown = (e: MouseEvent) => {
			// Stop propagation so CM6 main editor doesn't steal focus/click
			e.stopPropagation();
			// Let click focus our margin editor
		};

		const onClick = (e: MouseEvent) => {
			// If already editing, let CM handle cursor
			if (this.cmView) {
				e.stopPropagation();
				return;
			}

			e.preventDefault();
			e.stopPropagation();
			this.startMarginEdit(margin);
		};

		margin.addEventListener("mousedown", onMouseDown);
		margin.addEventListener("click", onClick);
	}

	private startMarginEdit(margin: HTMLElement) {
		if (this.cmView) return;

		this.originalText = this.content;

		this.plugin.setActiveFootnoteEdit(this.footnoteId);
		margin.dataset.editing = "true";
		margin.innerHTML = "";

		const commitKeymap = this.makeCommitKeymap(margin);

		const state = EditorState.create({
			doc: this.content,
			extensions: [
				commitKeymap,
				sidenoteEditorTheme,
				history(),
				markdown(),
				syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				markdownEditHotkeys,
				// keep Obsidian’s own hotkey routing possible
				keymap.of(defaultKeymap),
				keymap.of(historyKeymap),
				EditorView.lineWrapping,
				// ESC to close (cancel)
				keymap.of([
					{
						key: "Escape",
						run: () => {
							this.closeMarginEditor(margin, { commit: false });
							return true;
						},
					},
				]),
			],
		});

		const cm = new EditorView({ state, parent: margin });
		// After creating the EditorView, force-remove the padding:
		this.cmView = cm;
		cm.dom.classList.add("sidenote-cm-editor");

		// Force override the scroller padding that CM6 sets internally
		const scroller = cm.dom.querySelector<HTMLElement>(".cm-scroller");
		if (scroller) {
			setCssProps(scroller, { "padding-left": "0" }, true);
			setCssProps(scroller, { padding: "0" }, true);
		}
		this.cmView = cm;
		cm.dom.classList.add("sidenote-cm-editor");

		// Route Obsidian commands to margin editor while it has focus
		cm.dom.addEventListener(
			"focusin",
			() => this.setActiveEditorForMargin(cm),
			true,
		);

		cm.dom.addEventListener(
			"focusout",
			() => {
				// Don’t close here — focusout is not reliable for “click outside” with CM.
				// Just drop activeEditor routing.
				this.setActiveEditorForMargin(null);
			},
			true,
		);

		// Click anywhere outside -> commit and close (reliable)
		this.outsidePointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;

			// If click is inside the CM editor or the margin container, ignore
			if (cm.dom.contains(target) || margin.contains(target)) return;

			this.closeMarginEditor(margin, { commit: true });
		};
		document.addEventListener(
			"pointerdown",
			this.outsidePointerDown,
			true,
		);

		requestAnimationFrame(() => cm.focus());
	}

	private commitAndCloseMarginEditor(margin: HTMLElement) {
		const cm = this.cmView;
		if (!cm) return;

		const newText = cm.state.doc.toString();

		// Tear down CM first (prevents weird focus/key routing issues)
		this.cmView = null;
		cm.destroy();

		// Restore Obsidian active editor routing
		setWorkspaceActiveEditor(this.plugin, null);

		// Clear active edit tracking so your ViewPlugin can rebuild decorations
		this.plugin.setActiveFootnoteEdit(null);

		margin.dataset.editing = "false";

		if (newText === this.content) {
			margin.innerHTML = "";
			margin.appendChild(
				this.plugin.renderLinksToFragmentPublic(
					this.plugin.normalizeTextPublic(newText),
				),
			);
			return;
		}

		// Reuse your existing footnote-definition replacement logic (slightly refactored)
		const view =
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.editor) {
			margin.innerHTML = "";
			margin.appendChild(
				this.plugin.renderLinksToFragmentPublic(
					this.plugin.normalizeTextPublic(newText),
				),
			);
			return;
		}

		const editor = view.editor;
		const content = editor.getValue();

		const escapedId = this.footnoteId.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);
		const footnoteDefRegex = new RegExp(
			`^(\\[\\^${escapedId}\\]:\\s*)(.+(?:\\n(?:[ \\t]+.+)*)?)$`,
			"gm",
		);

		const match = footnoteDefRegex.exec(content);
		if (match) {
			const prefix = match[1] ?? "";
			const from = editor.offsetToPos(match.index + prefix.length);
			const to = editor.offsetToPos(match.index + match[0].length);

			editor.replaceRange(newText, from, to);
			// Don’t manually re-render; the CM6 decoration will rebuild now that activeFootnoteEdit is null
			return;
		}

		// If we couldn't find the footnote definition, fall back to rendering
		margin.innerHTML = "";
		margin.appendChild(
			this.plugin.renderLinksToFragmentPublic(
				this.plugin.normalizeTextPublic(newText),
			),
		);
	}

	eq(other: FootnoteSidenoteWidget): boolean {
		return (
			this.content === other.content &&
			this.numberText === other.numberText &&
			this.footnoteId === other.footnoteId
		);
	}

	ignoreEvent(): boolean {
		// Allow click and mousedown events to be handled by our handlers
		return false;
	}
}

/**
 * CodeMirror 6 ViewPlugin that adds sidenote decorations for footnotes.
 */
class FootnoteSidenoteViewPlugin {
	decorations: DecorationSet;

	constructor(
		private view: EditorView,
		private plugin: SidenotePlugin,
	) {
		this.decorations = this.buildDecorations(view.state);
	}

	update(update: ViewUpdate) {
		// Don't rebuild decorations while a footnote is being edited
		// This prevents the widget from being recreated mid-edit
		if (this.plugin.isFootnoteBeingEdited()) {
			return;
		}

		if (
			update.docChanged ||
			update.viewportChanged ||
			update.geometryChanged
		) {
			this.decorations = this.buildDecorations(update.state);
		}
	}

	buildDecorations(state: EditorState): DecorationSet {
		// Only show footnote sidenotes in editing mode when using footnote-edit format
		if (this.plugin.settings.sidenoteFormat !== "footnote-edit") {
			return Decoration.none;
		}

		const decorations: { from: number; decoration: Decoration }[] = [];
		const content = state.doc.toString();

		// Parse footnote definitions first
		const footnoteDefinitions =
			this.plugin.parseFootnoteDefinitionsPublic(content);

		// Find all footnote references [^id] (not definitions [^id]:)
		const referenceRegex = /\[\^([^\]]+)\](?!:)/g;
		let match: RegExpExecArray | null;

		// Track footnote order for numbering
		const footnoteOrder: string[] = [];

		// First pass: collect all footnote references in order
		while ((match = referenceRegex.exec(content)) !== null) {
			const id = match[1];
			if (id && !footnoteOrder.includes(id)) {
				footnoteOrder.push(id);
			}
		}

		// Reset regex
		referenceRegex.lastIndex = 0;

		// Assign numbers based on order of appearance
		const footnoteNumbers = new Map<string, number>();
		footnoteOrder.forEach((id, index) => {
			footnoteNumbers.set(id, index + 1);
		});

		// Second pass: create decorations
		while ((match = referenceRegex.exec(content)) !== null) {
			const from = match.index;
			const to = from + match[0].length;
			const id = match[1];

			if (!id) continue;

			const footnoteContent = footnoteDefinitions.get(id);
			if (!footnoteContent) continue;

			const itemNum = footnoteNumbers.get(id) ?? 1;
			const numberText = this.plugin.formatNumberPublic(itemNum);

			decorations.push({
				from: to,
				decoration: Decoration.widget({
					widget: new FootnoteSidenoteWidget(
						footnoteContent,
						numberText,
						id,
						this.plugin,
					),
					side: 1,
				}),
			});
		}

		// Sort by position and create DecorationSet
		decorations.sort((a, b) => a.from - b.from);
		return Decoration.set(
			decorations.map((d) => d.decoration.range(d.from)),
		);
	}

	destroy() {
		// Cleanup if needed
	}
}

/**
 * Create the CodeMirror 6 ViewPlugin for footnote sidenotes.
 */
function createFootnoteSidenotePlugin(plugin: SidenotePlugin) {
	return ViewPlugin.fromClass(
		class {
			inner: FootnoteSidenoteViewPlugin;

			constructor(view: EditorView) {
				this.inner = new FootnoteSidenoteViewPlugin(view, plugin);
			}

			update(update: ViewUpdate) {
				this.inner.update(update);
			}

			destroy() {
				this.inner.destroy();
			}
		},
		{
			decorations: (v) => v.inner.decorations,
		},
	);
}
