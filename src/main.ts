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
	HighlightStyle,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

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
	textColor: string;
	hoverColor: string;
	textAlignment: "left" | "right" | "justify";

	// Behavior
	collisionSpacing: number;
	enableTransitions: boolean;
	resetNumberingPerHeading: boolean;
	editInReadingMode: boolean;
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
	textColor: "",
	hoverColor: "",
	textAlignment: "left",

	// Behavior
	collisionSpacing: 8,
	enableTransitions: true,
	resetNumberingPerHeading: false,
	editInReadingMode: false,
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

	// Incremented on every settings save to signal the CM6 ViewPlugin to rebuild
	private _settingsVersion = 0;

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
	public needsReadingModeRefresh = true;

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

	// Reading-mode footnote editing state
	private readingCmView: EditorView | null = null;
	private readingCmOutsidePointerDown?: (ev: PointerEvent) => void;
	private readingCmOriginalText: string = "";
	private readingCmFootnoteId: string = "";
	private activeReadingModeMargin: HTMLElement | null = null;

	// Track the currently editing margin element for the global capture listener
	private currentlyEditingMargin: HTMLElement | null = null;
	// Cooldown timer after a reading-mode edit commit to prevent
	// the MutationObserver-triggered rebuild from overwriting the
	// freshly re-rendered margin with stale source data.
	private postEditCooldown: number | null = null;

	// Pre-cached file content for PDF export (keyed by file path)
	private fileContentCache = new Map<string, string>();

	// Delegated click handler for reading mode margins (survives virtualization)
	private readingModeDelegateHandler: ((ev: MouseEvent) => void) | null =
		null;

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
				if (this.settings.sidenoteFormat !== "html") {
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

				// Inject print sidenotes synchronously for PDF export
				this.injectPrintSidenotes(element, context);
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
				this.footnoteProcessingRetries = 0;
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
				this.needsFullRenumber = true;
				this.invalidateLayoutCache();
				this.scheduleLayoutDebounced(SidenotePlugin.MUTATION_DEBOUNCE);
				void this.preCacheFileContent();
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
		// Clear post-edit cooldown
		if (this.postEditCooldown !== null) {
			window.clearTimeout(this.postEditCooldown);
			this.postEditCooldown = null;
		}

		// Clear delegated reading mode handler
		this.readingModeDelegateHandler = null;

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

	public forceReadingModeRefreshPublic() {
		this.forceReadingModeRefresh();
	}

	public refreshCachedSourceContentPublic() {
		this.refreshCachedSourceContent();
	}

	public injectStylesPublic() {
		this.injectStyles();
	}

	public get settingsVersion(): number {
		return this._settingsVersion;
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

			// Bump the settings version so the CM6 ViewPlugin rebuilds
			this._settingsVersion++;

			// Apply new CSS variables
			this.injectStyles();

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
			const cmEditor = (mdView?.editor as any)?.cm as
				| EditorView
				| undefined;
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
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file ?? this.app.workspace.getActiveFile();
		if (!file) return;

		const content = await this.app.vault.cachedRead(file);
		if (content) {
			this.fileContentCache.set(file.path, content);
			console.log(content);
		}
	}

	/**
	 * Clean up sidenote markup from reading mode only.
	 * Never manually remove DOM inside CM6 .cm-content — that
	 * corrupts CM6's internal state and causes sidenotes to vanish.
	 */
	private cleanupReadingMode() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
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
	 * Install a single delegated click handler on the reading-mode root.
	 * This survives DOM virtualization because it lives on the persistent
	 * ancestor, not on individual margin elements that Obsidian may destroy.
	 */
	private ensureReadingModeDelegation(readingRoot: HTMLElement) {
		// Already installed on this element
		if (this.readingModeDelegateHandler) return;

		const handler = (ev: MouseEvent) => {
			if (!this.settings.editInReadingMode) return;

			const target = ev.target as HTMLElement | null;
			if (!target) return;

			const margin = target.closest<HTMLElement>("small.sidenote-margin");
			if (!margin) return;

			// Don't interfere with an editor that's already open
			if (margin.dataset.editing === "true") {
				ev.stopPropagation();
				return;
			}

			// Don't intercept clicks on links inside the margin
			if (target.closest("a")) return;

			ev.preventDefault();
			ev.stopPropagation();

			const sidenoteType = margin.dataset.sidenoteType;
			if (sidenoteType === "footnote") {
				const footnoteId = margin.dataset.footnoteId;
				if (!footnoteId) return;

				// The margin already displays the correct text (it was
				// re-rendered after the last commit). Read from it
				// directly to avoid any stale-cache issues with
				// vault.process() async timing.
				const displayedText = this.normalizeText(margin.textContent ?? "");

				// Strip the number prefix if the margin's ::before
				// content is included in textContent (it isn't for
				// pseudo-elements, but guard against it)
				const footnoteText =
					displayedText || this.getFootnoteSourceText(footnoteId) || "";
				if (!footnoteText) return;

				this.startReadingModeFootnoteEdit(
					margin,
					footnoteId,
					footnoteText,
				);
			} else if (sidenoteType === "html") {
				const indexStr = margin.dataset.sidenoteIndex;
				if (indexStr === undefined) return;
				const sidenoteIndex = parseInt(indexStr, 10);
				if (isNaN(sidenoteIndex)) return;

				const rawText = this.getHtmlSidenoteSourceText(sidenoteIndex);
				if (rawText !== null) {
					this.startReadingModeHtmlEdit(margin, sidenoteIndex, rawText);
				}
			}
		};

		readingRoot.addEventListener("click", handler, true);
		this.readingModeDelegateHandler = handler;

		// Store a cleanup that removes the handler if the view is torn down
		this.cleanups.push(() => {
			readingRoot.removeEventListener("click", handler, true);
			this.readingModeDelegateHandler = null;
		});
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

		// Print margin changes
		this.injectPrintPageStyle();

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

		// Find a representative line/paragraph to measure the text column edge.
		// In reading mode, Obsidian virtualises content so the first <p> may
		// have zero size or be nested inside a blockquote/list.  Walk the
		// sizer's direct child <div>s and pick the first one that contains a
		// visible block-level element at the top level of the content flow.
		let refLine: HTMLElement | null = null;
		if (isReadingMode) {
			const sizer = root.querySelector<HTMLElement>(
				".markdown-preview-sizer",
			);
			if (sizer) {
				const sections =
					sizer.querySelectorAll<HTMLElement>(":scope > div");
				for (const section of Array.from(sections)) {
					if (section.offsetHeight === 0) continue;
					const candidate = section.querySelector<HTMLElement>(
						":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6",
					);
					if (candidate && candidate.offsetHeight > 0) {
						refLine = candidate;
						break;
					}
				}
			}
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
	private correctIndentedSidenotePositions(root: HTMLElement) {
		const position = this.settings.sidenotePosition;

		// Read the global offset that updateSidenotePositioning just set
		const globalOffset =
			parseFloat(root.style.getPropertyValue("--sidenote-offset")) || 0;

		// Find the SAME reference element updateSidenotePositioning used
		const sizer = root.querySelector<HTMLElement>(
			".markdown-preview-sizer",
		);
		if (!sizer) return;

		let refEl: HTMLElement | null = null;
		const sections = sizer.querySelectorAll<HTMLElement>(":scope > div");
		for (const section of Array.from(sections)) {
			if (section.offsetHeight === 0) continue;
			const candidate = section.querySelector<HTMLElement>(
				":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6",
			);
			if (candidate && candidate.offsetHeight > 0) {
				refEl = candidate;
				break;
			}
		}
		if (!refEl) return;

		const refRect = refEl.getBoundingClientRect();

		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
			const indentedParent = wrapper.closest(
				"li, blockquote, .callout-content",
			) as HTMLElement | null;

			if (!indentedParent) {
				// Not indented — inherit the global offset
				wrapper.style.removeProperty("--sidenote-offset");
				continue;
			}

			const parentRect = indentedParent.getBoundingClientRect();

			if (position === "left") {
				// Global offset is relative to refEl's left edge.
				// This wrapper resolves position:absolute against indentedParent.
				// Shift = how much further right the parent is vs refEl.
				const shift = parentRect.left - refRect.left;
				wrapper.style.setProperty(
					"--sidenote-offset",
					`${globalOffset - shift}px`,
				);
			} else {
				// Global offset is relative to refEl's right edge.
				// Shift = how much further left the parent's right edge is vs refEl.
				const shift = refRect.right - parentRect.right;
				wrapper.style.setProperty(
					"--sidenote-offset",
					`${globalOffset - shift}px`,
				);
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

		// Skip full reprocessing during the post-edit cooldown.
		// After a reading-mode edit, the margin was already re-rendered
		// with the correct text. Obsidian's async DOM re-render fires
		// the MutationObserver, but source caches may still be stale.
		// Let the cooldown expire before allowing a full rebuild.
		if (this.postEditCooldown !== null) {
			return;
		}

		// Ensure the delegated click handler is installed (survives virtualization)
		this.ensureReadingModeDelegation(readingRoot);

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
				requestAnimationFrame(() => {
					if (!readingRoot.isConnected) return;

					// Force reflow so measurements are accurate
					void readingRoot.offsetHeight;

					// Re-apply global offset based on current settings (text vs edge)
					this.updateSidenotePositioning(readingRoot, true);

					// Re-apply per-wrapper corrections (li/blockquote/callout)
					this.correctIndentedSidenotePositions(readingRoot);

					// Optional but usually good: re-resolve collisions
					const allMargins = Array.from(
						readingRoot.querySelectorAll<HTMLElement>(
							"small.sidenote-margin",
						),
					).filter((m) => m.isConnected);

					this.resolveCollisions(
						allMargins,
						this.settings.collisionSpacing,
					);
				});
			}
			return;
		}

		const isFullRefresh = this.needsReadingModeRefresh;
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

		// Only do full teardown on explicit refresh (file change, settings change).
		// For incremental processing (new sections scrolled into view), keep
		// existing sidenotes and only wrap the new unwrapped refs.
		if (isFullRefresh) {
			this.removeAllSidenoteMarkupFromReadingMode(readingRoot);
		}

		const sizer =
			readingRoot.querySelector<HTMLElement>(".markdown-preview-sizer") ??
			readingRoot;

		const sizerRect = sizer.getBoundingClientRect();

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

			if (definitions.size === 0) {
				if (!useHtmlSidenotes) return;
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
				if (this.settings.editInReadingMode) {
					margin.dataset.editing = "false";
					margin.dataset.sidenoteType = "html";
					margin.dataset.sidenoteIndex = String(num - 1);
					margin.style.cursor = "pointer";
				}
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

				if (this.settings.editInReadingMode && item.footnoteId) {
					margin.dataset.sidenoteType = "footnote";
					margin.dataset.footnoteId = item.footnoteId;
					margin.style.cursor = "pointer";
				}
			}

			item.el.parentNode?.insertBefore(wrapper, item.el);
			wrapper.appendChild(item.el);
			wrapper.appendChild(margin);

			// Per-item horizontal correction for indented parents is deferred
			// to correctIndentedSidenotePositions() in the RAF block below,
			// which runs after updateSidenotePositioning() so both use the
			// same reference element.

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

				// Correct per-wrapper offset for indented parents
				this.correctIndentedSidenotePositions(readingRoot);

				// Use all margins in the DOM (not just newly created ones)
				// so that collisions between old and new sidenotes are resolved.
				const allMargins = Array.from(
					readingRoot.querySelectorAll<HTMLElement>(
						"small.sidenote-margin",
					),
				).filter((m) => m.isConnected);

				this.resolveCollisions(allMargins, this.settings.collisionSpacing);
			});
		});
	}

	private injectPrintPageStyle() {
		document.getElementById("sidenote-print-page-style")?.remove();

		const style = document.createElement("style");
		style.id = "sidenote-print-page-style";

		const isRight = this.settings.sidenotePosition !== "left";

		style.textContent = isRight
			? `@page { 
				margin-left: 1.5cm; 
				margin-right: 0.1cm; 
				margin-top: 1.5cm; 
				margin-bottom: 1.5cm; 
			}`
			: `@page { 
				margin-left: 0.1cm; 
				margin-right: 1.5cm; 
				margin-top: 1.5cm; 
				margin-bottom: 1.5cm; 
			}`;

		document.head.appendChild(style);
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
		// Also remove any print-only sidenote elements
		root.querySelectorAll(".sidenote-print").forEach((el) => el.remove());
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

	// ==================== Reading Mode HTML Editing ========================

	/**
	 * Extract the raw markdown text of the Nth sidenote from the source file.
	 */
	private getHtmlSidenoteSourceText(sidenoteIndex: number): string | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const content =
			view?.editor?.getValue() ||
			(view as any)?.data ||
			this.cachedSourceContent ||
			"";
		if (!content) return null;

		const regex =
			/<span\s+class\s*=\s*["']sidenote["'][^>]*>([\s\S]*?)<\/span>/gi;
		let match: RegExpExecArray | null;
		let idx = 0;

		while ((match = regex.exec(content)) !== null) {
			if (idx === sidenoteIndex) {
				return match[1] ?? "";
			}
			idx++;
		}
		return null;
	}

	/**
	 * Read the current footnote definition text from the source file.
	 * Always reads fresh from the editor/cache so delegated clicks
	 * never use stale text captured at DOM-creation time.
	 */
	private getFootnoteSourceText(footnoteId: string): string | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const content =
			this.cachedSourceContent ||
			view?.editor?.getValue() ||
			(view as any)?.data ||
			"";
		if (!content) return null;

		const definitions = this.parseFootnoteDefinitions(content);
		return definitions.get(footnoteId) ?? null;
	}

	/**
	 * Open a CM6 editor for an HTML span sidenote in reading mode,
	 * using the raw markdown source text.
	 */
	private startReadingModeHtmlEdit(
		margin: HTMLElement,
		sidenoteIndex: number,
		rawText: string,
	) {
		// Close any existing editor
		if (this.spanCmView) return;

		this.spanOriginalText = rawText;
		this.activeReadingModeMargin = margin;

		margin.dataset.editing = "true";
		margin.innerHTML = "";

		const commitAndClose = (opts: { commit: boolean }) => {
			const cm = this.spanCmView;
			if (!cm) return;

			const newText = cm.state.doc.toString();
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
			cm.destroy();

			setWorkspaceActiveEditor(this, null);

			margin.dataset.editing = "false";

			if (opts.commit && newText !== this.spanOriginalText) {
				this.commitHtmlSpanSidenoteText(sidenoteIndex, newText);
			}

			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(renderText)),
			);

			if (this.settings.editInReadingMode) {
				margin.style.cursor = "pointer";
			}

			this.activeReadingModeMargin = null;

			// Refresh cache and signal cross-mode update
			if (opts.commit && newText !== this.spanOriginalText) {
				this.refreshCachedSourceContent();
				this.needsReadingModeRefresh = true;
				this.needsFullRenumber = true;
				this.invalidateLayoutCache();
			}
		};

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
			doc: rawText,
			extensions: [
				closeKeymap,
				sidenoteEditorTheme,
				history(),
				markdown(),
				syntaxHighlighting(sidenoteHighlightStyle, { fallback: true }),
				markdownEditHotkeys,
				keymap.of(historyKeymap),
				keymap.of(defaultKeymap),
				EditorView.lineWrapping,
			],
		});

		const cm = new EditorView({ state, parent: margin });
		this.spanCmView = cm;
		cm.dom.classList.add("sidenote-cm-editor");

		const scroller = cm.dom.querySelector<HTMLElement>(".cm-scroller");
		if (scroller) {
			setCssProps(scroller, { "padding-left": "0", padding: "0" }, true);
		}

		cm.dom.addEventListener(
			"focusin",
			() => setWorkspaceActiveEditor(this, cm),
			true,
		);
		cm.dom.addEventListener(
			"focusout",
			() => setWorkspaceActiveEditor(this, null),
			true,
		);

		const cleanupKeyboard = this.setupMarginKeyboardCapture(margin);
		const snMargin = margin as SidenoteMarginElement;
		snMargin._sidenoteCleanup = () => {
			cleanupKeyboard();
			if (this.spanCmView === cm) {
				commitAndClose({ commit: false });
			}
		};

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

	// ==================== Reading Mode Footnote Editing ====================

	/**
	 * Open a CM6 editor inside a reading-mode sidenote margin for a footnote.
	 */
	private startReadingModeFootnoteEdit(
		margin: HTMLElement,
		footnoteId: string,
		footnoteText: string,
	) {
		// If already editing another reading-mode margin, commit it first
		if (this.readingCmView && this.activeReadingModeMargin) {
			this.finishReadingModeFootnoteEdit(
				this.activeReadingModeMargin,
				true,
			);
		}

		// Clear any post-edit cooldown from the previous edit
		if (this.postEditCooldown !== null) {
			window.clearTimeout(this.postEditCooldown);
			this.postEditCooldown = null;
		}

		this.readingCmOriginalText = footnoteText;
		this.readingCmFootnoteId = footnoteId;
		this.isEditingMargin = true;

		margin.dataset.editing = "true";
		this.activeReadingModeMargin = margin;
		margin.innerHTML = "";
		margin.style.cursor = "";

		const commitAndClose = (opts: { commit: boolean }) => {
			this.finishReadingModeFootnoteEdit(margin, opts.commit);
		};

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
			doc: footnoteText,
			extensions: [
				closeKeymap,
				sidenoteEditorTheme,
				history(),
				markdown(),
				syntaxHighlighting(sidenoteHighlightStyle, { fallback: true }),
				markdownEditHotkeys,
				keymap.of(historyKeymap),
				keymap.of(defaultKeymap),
				EditorView.lineWrapping,
			],
		});

		const cm = new EditorView({ state, parent: margin });
		this.readingCmView = cm;

		cm.dom.classList.add("sidenote-cm-editor");

		const scroller = cm.dom.querySelector<HTMLElement>(".cm-scroller");
		if (scroller) {
			setCssProps(scroller, { "padding-left": "0", padding: "0" }, true);
		}

		// Route Obsidian's active editor to this CM instance
		cm.dom.addEventListener(
			"focusin",
			() => setWorkspaceActiveEditor(this, cm),
			true,
		);
		cm.dom.addEventListener(
			"focusout",
			() => setWorkspaceActiveEditor(this, null),
			true,
		);

		// Set up keyboard capture so Obsidian hotkeys don't interfere
		const cleanupKeyboard = this.setupMarginKeyboardCapture(margin);
		const snMargin = margin as SidenoteMarginElement;
		snMargin._sidenoteCleanup = () => {
			cleanupKeyboard();
			if (this.readingCmView === cm) {
				this.finishReadingModeFootnoteEdit(margin, false);
			}
		};

		// Click outside → commit and close
		this.readingCmOutsidePointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null;
			if (!target) return;
			if (margin.contains(target) || cm.dom.contains(target)) return;
			commitAndClose({ commit: true });
		};
		document.addEventListener(
			"pointerdown",
			this.readingCmOutsidePointerDown,
			true,
		);

		requestAnimationFrame(() => cm.focus());

		// Watch for editor height changes and re-run collision avoidance
		const resizeObs = new ResizeObserver(() => {
			const readingRoot = this.app.workspace
				.getActiveViewOfType(MarkdownView)
				?.containerEl.querySelector<HTMLElement>(".markdown-reading-view");
			if (!readingRoot) return;

			const allMargins = Array.from(
				readingRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
			).filter((m) => m.isConnected);

			this.resolveCollisions(allMargins, this.settings.collisionSpacing);
		});

		resizeObs.observe(cm.dom);

		// Chain onto existing cleanup so teardown disconnects the observer
		const prevCleanup = snMargin._sidenoteCleanup;
		snMargin._sidenoteCleanup = () => {
			resizeObs.disconnect();
			if (prevCleanup) prevCleanup();
		};
	}

	/**
	 * Close the reading-mode footnote editor, optionally committing changes.
	 */
	private finishReadingModeFootnoteEdit(
		margin: HTMLElement,
		commit: boolean,
	) {
		const cm = this.readingCmView;
		if (!cm) return;

		const newText = cm.state.doc.toString();
		const renderText = commit ? newText : this.readingCmOriginalText;

		// Remove outside-click listener
		if (this.readingCmOutsidePointerDown) {
			document.removeEventListener(
				"pointerdown",
				this.readingCmOutsidePointerDown,
				true,
			);
			this.readingCmOutsidePointerDown = undefined;
		}

		// Destroy CM
		this.readingCmView = null;
		cm.destroy();

		// Restore Obsidian active editor routing
		setWorkspaceActiveEditor(this, null);

		// Keep isEditingMargin = true through the commit so that
		// editor-change doesn't set needsReadingModeRefresh = true
		// and the MutationObserver skips during the commit.
		margin.dataset.editing = "false";
		this.activeReadingModeMargin = null;

		// Commit to the source file if changed
		if (commit && newText !== this.readingCmOriginalText) {
			this.commitReadingModeFootnoteText(
				this.readingCmFootnoteId,
				newText,
			);

			// Immediately patch the cached source content so that
			// clicking the sidenote again reads the new text, rather
			// than waiting for the async file write to propagate.
			if (this.cachedSourceContent) {
				const escapedId = this.readingCmFootnoteId.replace(
					/[.*+?^${}()|[\]\\]/g,
					"\\$&",
				);
				const regex = new RegExp(
					`^(\\[\\^${escapedId}\\]:\\s*)(.+(?:\\n(?:[ \\t]+.+)*)?)$`,
					"gm",
				);
				const match = regex.exec(this.cachedSourceContent);
				if (match) {
					const prefix = match[1] ?? "";
					const before = this.cachedSourceContent.slice(
						0,
						match.index + prefix.length,
					);
					const after = this.cachedSourceContent.slice(
						match.index + match[0].length,
					);
					this.cachedSourceContent = before + newText + after;
				}
			}
		}

		// NOW clear the editing flag
		this.isEditingMargin = false;

		// Re-render the sidenote display with the correct text
		margin.innerHTML = "";
		margin.appendChild(
			this.renderLinksToFragment(this.normalizeText(renderText)),
		);

		// Set a cooldown to prevent the MutationObserver-triggered
		// rebuild from overwriting this margin with stale source data.
		// Obsidian re-renders the preview DOM asynchronously after the
		// file write, which fires the MutationObserver → scheduleFootnoteProcessing
		// → processReadingModeSidenotes. If that rebuild reads source content
		// before Obsidian has updated its internal cache, it gets the OLD text
		// and overwrites our correct re-render.
		if (commit && newText !== this.readingCmOriginalText) {
			if (this.postEditCooldown !== null) {
				window.clearTimeout(this.postEditCooldown);
			}
			this.postEditCooldown = window.setTimeout(() => {
				this.postEditCooldown = null;
				// Now that Obsidian has had time to update its caches,
				// refresh our cached content too
				this.refreshCachedSourceContent();
			}, 500);
		}

		// Re-run collision avoidance since the margin height changed
		requestAnimationFrame(() => {
			const readingRoot = this.app.workspace
				.getActiveViewOfType(MarkdownView)
				?.containerEl.querySelector<HTMLElement>(".markdown-reading-view");
			if (!readingRoot) return;

			const allMargins = Array.from(
				readingRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
			).filter((m) => m.isConnected);

			this.resolveCollisions(allMargins, this.settings.collisionSpacing);
		});

		// Restore click cursor if editing is enabled
		if (this.settings.editInReadingMode) {
			margin.style.cursor = "pointer";
		}
	}

	/**
	 * Write the new footnote text back to the source file.
	 * Works even in reading mode by using view.editor (which Obsidian
	 * keeps synchronized) or falling back to vault.modify().
	 */
	private commitReadingModeFootnoteText(
		footnoteId: string,
		newText: string,
	) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file ?? this.app.workspace.getActiveFile();
		if (!file) return;

		void this.app.vault.process(file, (content) => {
			const escapedId = footnoteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(
				`^(\\[\\^${escapedId}\\]:\\s*)(.+(?:\\n(?:[ \\t]+.+)*)?)$`,
				"gm",
			);

			const match = regex.exec(content);
			if (!match) return content; // no change

			const prefix = match[1] ?? "";
			const before = content.slice(0, match.index + prefix.length);
			const after = content.slice(match.index + match[0].length);

			return before + newText + after;
		});
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
					this.correctIndentedSidenotePositions(readingRoot);
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
	 * Re-read source content from the editor and update the cache.
	 * Call this after any commit (editing or reading mode) so that
	 * subsequent mode switches and undo operations see fresh data.
	 */
	private refreshCachedSourceContent() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const content = view?.editor?.getValue() || (view as any)?.data || "";
		if (content) {
			this.cachedSourceContent = content;
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

	// ==================== Print Handling ====================

	/**
	 * Inject print sidenotes into a post-processed element.
	 * Runs synchronously so the elements exist before Obsidian
	 * captures the DOM for PDF export.
	 */
	private injectPrintSidenotes(element: HTMLElement, context?: any) {
		if (element.querySelector(".sidenote-print")) return;

		const position = this.settings.sidenotePosition;
		const isRight = position !== "left";

		if (this.settings.sidenoteFormat === "html") {
			// ... existing working HTML logic unchanged ...
			const spans = element.querySelectorAll<HTMLElement>("span.sidenote");
			if (spans.length === 0) return;

			const sidenotesByAnchor = new Map<HTMLElement, HTMLElement[]>();
			let counter = 0;

			for (const span of Array.from(spans)) {
				const text = span.textContent ?? "";
				if (!text.trim()) continue;

				counter++;

				const refNum = document.createElement("sup");
				refNum.style.cssText =
					"font-size: 0.75em; font-weight: bold; color: #000;";
				refNum.textContent = this.formatNumber(counter);
				span.parentNode?.insertBefore(refNum, span.nextSibling);

				const printEl = this.buildPrintSidenote(
					text,
					this.formatNumber(counter),
				);

				const anchor = span.closest(
					"p, li, h1, h2, h3, h4, h5, h6",
				) as HTMLElement | null;
				if (anchor) {
					const list = sidenotesByAnchor.get(anchor) ?? [];
					list.push(printEl);
					sidenotesByAnchor.set(anchor, list);
				}
			}

			this.buildPrintTables(element, sidenotesByAnchor, isRight);
			return;
		}

		// Footnote format — get content from all available sources
		const sourcePath = context?.sourcePath ?? "";
		const content =
			this.cachedSourceContent ||
			(sourcePath ? this.fileContentCache.get(sourcePath) : "") ||
			"";

		if (!content) return;

		const definitions = this.parseFootnoteDefinitions(content);
		if (definitions.size === 0) return;

		const refs = element.querySelectorAll<HTMLElement>(
			"sup.footnote-ref, sup[class*='footnote'], sup[id^='fnref-'], a.footnote-link",
		);
		if (refs.length === 0) return;

		const sidenotesByAnchor = new Map<HTMLElement, HTMLElement[]>();
		const processedIds = new Set<string>();
		let counter = 0;

		for (const ref of Array.from(refs)) {
			const id = this.extractFootnoteId(ref);
			if (!id || processedIds.has(id)) continue;
			processedIds.add(id);

			const text = definitions.get(id);
			if (!text) continue;

			counter++;

			const refTarget =
				ref.tagName === "SUP" ? ref : (ref.closest("sup") ?? ref);
			const refNum = document.createElement("sup");
			refNum.style.cssText =
				"font-size: 0.75em; font-weight: bold; color: #000;";
			refNum.textContent = this.formatNumber(counter);
			refTarget.parentNode?.insertBefore(refNum, refTarget.nextSibling);

			const printEl = this.buildPrintSidenote(
				text,
				this.formatNumber(counter),
			);

			const sup = ref.tagName === "SUP" ? ref : ref.closest("sup");
			const anchor = sup?.closest(
				"p, li, h1, h2, h3, h4, h5, h6",
			) as HTMLElement | null;
			if (anchor) {
				const list = sidenotesByAnchor.get(anchor) ?? [];
				list.push(printEl);
				sidenotesByAnchor.set(anchor, list);
			}
		}

		this.buildPrintTables(element, sidenotesByAnchor, isRight);
	}

	/**
	 * Shared logic: wrap anchor paragraphs in table layouts and
	 * inject the max-width style constraint.
	 */
	private buildPrintTables(
		element: HTMLElement,
		sidenotesByAnchor: Map<HTMLElement, HTMLElement[]>,
		isRight: boolean,
	) {
		if (sidenotesByAnchor.size === 0) return;

		for (const [anchor, sidenotes] of sidenotesByAnchor) {
			if (!anchor.parentNode) continue;

			const table = document.createElement("table");
			table.className = "sidenote-print-table";
			table.style.cssText = `
				width: 100%; 
				border-collapse: collapse; 
				border: none; 
				margin: 0; 
				padding: 0; 
				table-layout: fixed;
			`;

			const row = document.createElement("tr");
			row.style.cssText = "border: none; vertical-align: top;";

			const contentCell = document.createElement("td");
			contentCell.style.cssText =
				"border: none; padding: 0; vertical-align: top; width: 70%;";

			const sidenoteCell = document.createElement("td");
			sidenoteCell.style.cssText = isRight
				? `border: none; 
				padding: 2.5em 0 0 2em; 
				vertical-align: top; 
				width: 30%; 
				font-size: 0.75em; 
				line-height: 1.35; 
				color: #000;`
				: `border: none; 
				padding: 2.5em 2em 0 0; 
				vertical-align: top; 
				width: 30%; 
				font-size: 0.75em; 
				line-height: 1.35; 
				color: #000; 
				text-align: right;`;

			anchor.parentNode.insertBefore(table, anchor);
			contentCell.appendChild(anchor);

			for (const sn of sidenotes) {
				if (sidenoteCell.childNodes.length > 0) {
					const spacer = document.createElement("div");
					spacer.style.cssText = "height: 0.4em;";
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

		// Inject width-constraining style
		if (!element.querySelector(".sidenote-print-width-style")) {
			const style = document.createElement("style");
			style.className = "sidenote-print-width-style";
			style.textContent = isRight
				? `
				p, li, h1, h2, h3, h4, h5, h6, blockquote, .callout,
				ul, ol, hr, .math, .MathJax, pre, .contains-task-list {
					max-width: 70% !important;
				}
				section.footnotes {
					max-width: 70% !important;
				}
				.sidenote-print-table,
				.sidenote-print-table td,
				.sidenote-print-table p,
				.sidenote-print-table li,
				.sidenote-print-table h1,
				.sidenote-print-table h2,
				.sidenote-print-table h3,
				.sidenote-print-table h4,
				.sidenote-print-table h5,
				.sidenote-print-table h6 {
					max-width: none !important;
				}
			`
				: `
				p, li, h1, h2, h3, h4, h5, h6, blockquote, .callout,
				ul, ol, hr, .math, .MathJax, pre, .contains-task-list {
					max-width: 70% !important;
					margin-left: 30% !important;
				}
				section.footnotes {
					max-width: 70% !important;
					margin-left: 30% !important;
				}
				.sidenote-print-table,
				.sidenote-print-table td,
				.sidenote-print-table p,
				.sidenote-print-table li,
				.sidenote-print-table h1,
				.sidenote-print-table h2,
				.sidenote-print-table h3,
				.sidenote-print-table h4,
				.sidenote-print-table h5,
				.sidenote-print-table h6 {
					max-width: none !important;
					margin-left: 0 !important;
				}
			`;
			element.appendChild(style);
		}
	}

	private buildPrintSidenote(text: string, numStr: string): HTMLElement {
		const printEl = document.createElement("small");
		printEl.className = "sidenote-print";
		// Use inline style so nothing can override visibility
		printEl.style.cssText = "display: block; margin: 0; padding: 0;";

		if (this.settings.showSidenoteNumbers) {
			const numSpan = document.createElement("span");
			numSpan.style.cssText =
				"font-weight: bold; margin-right: 0.3em; color: #333;";
			numSpan.textContent = numStr + ".";
			printEl.appendChild(numSpan);
		}

		printEl.appendChild(
			this.renderLinksToFragment(this.normalizeText(text)),
		);

		return printEl;
	}

	private extractFootnoteId(el: HTMLElement): string | null {
		if (el.dataset.footnoteId) return el.dataset.footnoteId;

		const id = el.id || el.closest("sup")?.id || "";
		const idMatch = id.match(/^fnref-?(.+?)(?:-\d+)?$/);
		if (idMatch?.[1]) return idMatch[1];

		const link = el.tagName === "A" ? el : el.querySelector("a");
		const href = link?.getAttribute("href") ?? "";
		const hrefMatch = href.match(/#fn-?(.+)/);
		if (hrefMatch?.[1]) return hrefMatch[1];

		return null;
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

			// Ensure delegated click handler for reading mode margins
			this.ensureReadingModeDelegation(readingRoot);

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
				syntaxHighlighting(sidenoteHighlightStyle, { fallback: true }),
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

		// Step 4: Sort by DOM order, not measured position.
		// Using rect.top can produce wrong order during layout transitions
		// (e.g. after editing a sidenote that changes height). DOM order
		// always reflects source order because decorations are sorted by
		// document position.
		items.sort((a, b) => {
			const pos = a.el.compareDocumentPosition(b.el);
			if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
			if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
			return 0;
		});

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
			.setName("Sidenote text color")
			.setDesc(
				"Color for sidenote text. Leave empty to use Obsidian's default text color.",
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g. #333333 or rgb(50,50,50)")
					.setValue(this.plugin.settings.textColor)
					.onChange(async (value) => {
						this.plugin.settings.textColor = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sidenote hover color")
			.setDesc(
				"Color for sidenote text *on hover*. Leave empty to use Obsidian's default *muted text* color.",
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g. #333333 or rgb(50,50,50)")
					.setValue(this.plugin.settings.hoverColor)
					.onChange(async (value) => {
						this.plugin.settings.hoverColor = value.trim();
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

		new Setting(containerEl)
			.setName("Allow Sidenote Edits in reading mode")
			.setDesc(
				"Click a sidenote in reading mode to edit the footnote text inline (only relevant if using footnote format)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.editInReadingMode)
					.onChange(async (value) => {
						this.plugin.settings.editInReadingMode = value;
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
		fontFamily: "inherit !important",
		fontSize: "inherit !important",
	},
	"& .cm-scroller": {
		padding: "0 !important",
		paddingLeft: "0 !important",
		paddingRight: "0 !important",
		margin: "0 !important",
		overflow: "visible !important",
		height: "auto !important",
		minHeight: "0 !important",
		fontFamily: "inherit !important",
	},
	"& .cm-content": {
		padding: "2px 0 !important",
		paddingLeft: "0 !important",
		margin: "0 !important",
		minHeight: "auto !important",
		fontFamily: "inherit !important",
		fontSize: "inherit !important",
		lineHeight: "inherit !important",
		caretColor:
			"var(--caret-color, var(--text-accent, var(--text-normal))) !important",
	},
	"& .cm-content[contenteditable]": {
		padding: "2px 0 !important",
		paddingLeft: "0 !important",
	},
	"& .cm-line": {
		padding: "0 !important",
		paddingLeft: "0 !important",
		margin: "0 !important",
		fontFamily: "inherit !important",
	},
	"& .cm-gutters": {
		display: "none !important",
		width: "0 !important",
		minWidth: "0 !important",
		border: "none !important",
	},
	"& .cm-cursor": {
		borderLeftColor: "var(--caret-color, var(--text-normal)) !important",
	},
	"&.cm-focused": {
		outline: "none !important",
	},
	"&.cm-focused .cm-cursor": {
		borderLeftColor: "var(--caret-color, var(--text-normal)) !important",
	},
	"& .cm-activeLineGutter": {
		backgroundColor: "transparent !important",
		display: "none !important",
	},
	"& .cm-activeLine": {
		backgroundColor: "transparent !important",
	},
});

const sidenoteHighlightStyle = HighlightStyle.define([
	{ tag: tags.strong, fontWeight: "bold" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.strikethrough, textDecoration: "line-through" },
	{
		tag: tags.monospace,
		fontFamily: "var(--font-monospace)",
		fontSize: "0.9em",
	},
	{
		tag: tags.link,
		color: "var(--link-color, var(--text-accent))",
		textDecoration: "underline",
	},
	{ tag: tags.url, color: "var(--link-color, var(--text-accent))" },
	// Dim the markdown syntax characters (**, *, `, [, ], etc.)
	{ tag: tags.processingInstruction, color: "var(--text-faint)" },
]);

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

		// Re-render with the CURRENT content (updated above if committed)
		margin.innerHTML = "";
		margin.appendChild(
			this.plugin.renderLinksToFragmentPublic(
				this.plugin.normalizeTextPublic(this.content),
			),
		);

		// Signal that reading mode needs a refresh if the user switches modes
		if (opts.commit && textToUse !== this.originalText) {
			this.plugin.needsReadingModeRefresh = true;
			this.plugin.refreshCachedSourceContentPublic();
		}
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

	/**
	 * Sets up Margin Editing - FOOTNOTES
	 * in EDITING MODE
	 */
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

	/**
	 * Starts margin editing - FOOTNOTES format
	 * In Editing Mode
	 */
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
				syntaxHighlighting(sidenoteHighlightStyle, { fallback: true }),
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

			// Signal cross-mode refresh and update cache
			this.plugin.needsReadingModeRefresh = true;
			this.plugin.refreshCachedSourceContentPublic();
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

	/**
	 * Read the current footnote definition text from the live editor
	 * document, bypassing any stale cached content on the widget.
	 */
	private getFreshContent(): string {
		const view =
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor;
		if (!editor) return this.content;

		const content = editor.getValue();
		if (!content) return this.content;

		const defs = this.plugin.parseFootnoteDefinitionsPublic(content);
		return defs.get(this.footnoteId) ?? this.content;
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
	private lastSettingsVersion: number;

	constructor(
		private view: EditorView,
		private plugin: SidenotePlugin,
	) {
		this.lastSettingsVersion = plugin.settingsVersion;
		this.decorations = this.buildDecorations(view.state);
	}

	update(update: ViewUpdate) {
		// Don't rebuild decorations while a footnote is being edited
		if (this.plugin.isFootnoteBeingEdited()) {
			return;
		}

		const settingsChanged =
			this.plugin.settingsVersion !== this.lastSettingsVersion;

		if (
			update.docChanged ||
			update.viewportChanged ||
			update.geometryChanged ||
			settingsChanged
		) {
			this.lastSettingsVersion = this.plugin.settingsVersion;
			this.decorations = this.buildDecorations(update.state);
		}
	}

	/* */
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
