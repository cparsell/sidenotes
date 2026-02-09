import {
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	App,
} from "obsidian";
import {
	EditorView,
	ViewUpdate,
	ViewPlugin,
	Decoration,
	DecorationSet,
	WidgetType,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";

type CleanupFn = () => void;

// Settings interface
// Settings interface
interface SidenoteSettings {
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

	// Source format
	sidenoteFormat: "html" | "footnote" | "footnote-edit";
}

const DEFAULT_SETTINGS: SidenoteSettings = {
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

	// Source format
	sidenoteFormat: "html",
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

	private pendingFootnoteEdit: string | null = null;
	private pendingFootnoteEditRetries = 0;

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
				// Only look for HTML sidenotes
				hasContent = element.querySelectorAll("span.sidenote").length > 0;
			} else {
				// Look for footnotes (both "footnote" and "footnote-edit" modes)
				hasContent =
					element.querySelectorAll("sup.footnote-ref, section.footnotes")
						.length > 0;
			}

			if (hasContent) {
				// Use a longer delay for footnotes to ensure section is rendered
				const delay =
					this.settings.sidenoteFormat !== "html"
						? SidenotePlugin.FOOTNOTE_RENDER_DELAY
						: 0;

				setTimeout(() => {
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							this.processReadingModeSidenotes(element);
						});
					});
				}, delay);
			}
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.resetRegistry();
				this.invalidateLayoutCache();
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
				this.scanDocumentForSidenotes();
				this.rebindAndSchedule();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				// Skip if we're in the middle of a margin edit
				if (this.isEditingMargin) return;

				this.scanDocumentForSidenotes();
				this.needsFullRenumber = true;
				this.invalidateLayoutCache();
				this.scheduleLayoutDebounced(SidenotePlugin.MUTATION_DEBOUNCE);
			}),
		);
		this.registerDomEvent(window, "resize", () => {
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
		if (this.styleEl) {
			try {
				this.styleEl.remove();
			} catch (e) {
				// Element may already be removed
			}
			this.styleEl = null;
		}

		this.styleEl = document.createElement("style");
		this.styleEl.id = "sidenote-plugin-styles";

		const s = this.settings;
		const transitionRule = s.enableTransitions
			? "transition: width 0.15s ease-out, left 0.15s ease-out, right 0.15s ease-out, opacity 0.15s ease-out;"
			: "";

		const defaultAlignment =
			s.sidenotePosition === "left" ? "right" : "left";
		const textAlign =
			s.textAlignment === "justify"
				? "justify"
				: s.textAlignment === "left" || s.textAlignment === "right"
					? s.textAlignment
					: defaultAlignment;

		// Number color - use custom color or default to theme
		const numberColorRule = s.numberColor
			? `color: ${s.numberColor} !important;`
			: "";

		// Neumorphic badge styles (square/rounded corners)
		const neumorphicStyles =
			s.numberBadgeStyle === "neumorphic"
				? `
					/* Neumorphic badge variables */
					:root {
								--sn-badge-bg: rgba(243, 245, 250, 0.05);
								--sn-badge-text: var(--text-muted);
								--sn-badge-border: rgba(243, 245, 250, 0.1);
								--sn-active-bg: rgba(243, 245, 250, 0.1);
								--sn-active-text: #ffffff;
					}

					.sidenote-margin[data-sidenote-num]::before {
								content: attr(data-sidenote-num) !important;
								display: inline-flex !important;
								align-items: center;
								justify-content: center;
								min-width: 1.7em;
								height: 1.7em;
								margin-right: 8px;
								padding: 0 4px;
								background-color: var(--sn-badge-bg) !important;
								border: 1px solid var(--sn-badge-border) !important;
								border-radius: 4px !important;
								color: ${s.numberColor || "var(--sn-badge-text)"} !important;
								font-family: var(--font-monospace) !important;
								font-size: 0.85em !important;
								font-weight: 600 !important;
								vertical-align: middle;
								line-height: 1;
					}

					.sidenote-margin:hover[data-sidenote-num]::before,
					.sidenote-margin[data-editing="true"][data-sidenote-num]::before {
								background-color: var(--sn-active-bg) !important;
								color: var(--sn-active-text) !important;
					}

					.sidenote-number::after {
								content: attr(data-sidenote-num);
								display: inline-flex;
								align-items: center;
								justify-content: center;
								min-width: 1.3em;
								height: 1.4em;
								background-color: var(--sn-badge-bg);
								border: 1px solid var(--sn-badge-border);
								border-radius: 3px;
								color: ${s.numberColor || "var(--sn-badge-text)"};
								font-size: 0.7em;
								font-weight: bold;
								margin-left: 2px;
								margin-right: 0.2rem;
								vertical-align: super;
								line-height: 0;
					}
							
							.sidenote-number:hover {
								color: #ffffff;
						}
					`
				: "";

		// Pill badge styles (fully rounded, gradient, shadow)
		const pillStyles =
			s.numberBadgeStyle === "pill"
				? `
					/* Pill badge variables */
					:root {
								--sn-pill-bg: rgba(255, 255, 255, 0.05);
								--sn-pill-text: #ffffff;
								--sn-pill-border: rgba(255, 255, 255, 0.1);
								--sn-pill-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
								--sn-pill-hover-shadow: 0 4px 8px rgba(0, 0, 0, 0.5);
					}

					.sidenote-margin[data-sidenote-num]::before {
								content: attr(data-sidenote-num) !important;
								display: inline-flex !important;
								align-items: center;
								justify-content: center;
								min-width: 1.5em;
								height: 1.5em;
								margin-right: 10px;
								padding: 0 6px;
								background: ${s.numberColor ? s.numberColor : "var(--sn-pill-bg)"} !important;
								border: 1px solid var(--sn-pill-border) !important;
								border-radius: 999px !important;
								color: var(--sn-pill-text) !important;
								font-family: var(--font-monospace) !important;
								font-size: 0.8em !important;
								font-weight: 700 !important;
								vertical-align: middle;
								line-height: 1;
								box-shadow: var(--sn-pill-shadow);
								transition: box-shadow 0.15s ease, transform 0.15s ease;
					}

					.sidenote-margin:hover[data-sidenote-num]::before {
								box-shadow: var(--sn-pill-hover-shadow);
								transform: scale(1.1);
					}

					.sidenote-margin[data-editing="true"][data-sidenote-num]::before {
								box-shadow: var(--sn-pill-hover-shadow);
								transform: scale(1.1);
					}

					.sidenote-number::after {
								content: attr(data-sidenote-num);
								display: inline-flex;
								align-items: center;
								justify-content: center;
								min-width: 1.2em;
								height: 1.2em;
								background: ${s.numberColor ? s.numberColor : "var(--sn-pill-bg)"};
								border: 1px solid var(--sn-pill-border) !important;
								border-radius: 999px;
								color: var(--sn-pill-text);
								font-size: 0.66em;
								font-weight: 700;
								margin-left: 2px;
								margin-right: 0.2rem;
								vertical-align: super;
								line-height: 0;
								box-shadow: var(--sn-pill-shadow);
					}

					.sidenote-number:hover::after {
						box-shadow: var(--sn-pill-hover-shadow);
					}

							.sidenote-number:hover {
								color: #ffffff;
							}
						`
				: "";

		// Plain number styles (when not neumorphic or pill)
		const plainNumberStyles =
			s.numberBadgeStyle === "plain"
				? `
					.sidenote-number {
						line-height: 0;
					}

					.sidenote-number::after {
						content: ${s.showSidenoteNumbers ? "attr(data-sidenote-num)" : "none"};
						vertical-align: baseline;
						position: relative;
						top: -0.5em;
						font-size: 0.7em;
						font-weight: bold;
						margin-right: 0.2rem;
						line-height: 0;
						${numberColorRule}
					}

					.sidenote-margin[data-sidenote-num]::before {
						content: ${s.showSidenoteNumbers ? 'attr(data-sidenote-num) ". "' : "none"};
						font-weight: bold;
						${numberColorRule}
					}
				`
				: "";

		// Generate positioning styles based on anchor mode
		const gap1 = s.sidenoteGap;
		const gap2 = s.sidenoteGap2;

		// For "text" mode: sidenotes positioned relative to text, gap is from text, gap2 is min from edge
		// For "edge" mode: sidenotes positioned relative to edge, gap is from edge, gap2 is min from text

		// Inside injectStyles(), replace the positioningStyles block with:

		// Replace the positioningStyles variable and related CSS with:

		const positioningStyles = `
			/* Sidenote positioning - uses --sidenote-offset calculated by JavaScript */
			
			/* LEFT POSITION */
			.markdown-source-view.mod-cm6[data-sidenote-position="left"] .sidenote-margin {
				left: var(--sidenote-offset, calc(-1 * (var(--sidenote-width) + var(--sidenote-gap))));
				right: auto;
				text-align: ${textAlign};
			}

			.markdown-reading-view[data-sidenote-position="left"] .sidenote-margin {
				left: var(--sidenote-offset, calc(-1 * (var(--sidenote-width) + var(--sidenote-gap))));
				right: auto;
				text-align: ${textAlign};
			}

			/* RIGHT POSITION */
			.markdown-source-view.mod-cm6[data-sidenote-position="right"] .sidenote-margin {
				right: var(--sidenote-offset, calc(-1 * (var(--sidenote-width) + var(--sidenote-gap))));
				left: auto;
				text-align: ${textAlign};
			}

			.markdown-reading-view[data-sidenote-position="right"] .sidenote-margin {
				right: var(--sidenote-offset, calc(-1 * (var(--sidenote-width) + var(--sidenote-gap))));
				left: auto;
				text-align: ${textAlign};
			}

			/* CM6 footnote widget - same positioning */
			.markdown-source-view.mod-cm6[data-sidenote-position="left"] .cm-line .sidenote-number[data-footnote-id] .sidenote-margin {
				left: var(--sidenote-offset, calc(-1 * (var(--sidenote-width) + var(--sidenote-gap))));
				right: auto;
				text-align: ${textAlign};
			}

			.markdown-source-view.mod-cm6[data-sidenote-position="right"] .cm-line .sidenote-number[data-footnote-id] .sidenote-margin {
				right: var(--sidenote-offset, calc(-1 * (var(--sidenote-width) + var(--sidenote-gap))));
				left: auto;
				text-align: ${textAlign};
			}
		`;

		this.styleEl.textContent = `
			/* === Sidenote layout variables === */
			.markdown-source-view.mod-cm6,
			.markdown-reading-view {
				--sidenote-base-width: ${s.minSidenoteWidth}rem;
				--sidenote-max-extra: ${s.maxSidenoteWidth - s.minSidenoteWidth}rem;
				--sidenote-width: calc(
					var(--sidenote-base-width) + 
					(var(--sidenote-max-extra) * var(--sidenote-scale, 0.5))
				);
				--sidenote-gap: ${gap1}rem;
				--sidenote-gap2: ${gap2}rem;
				--page-offset: calc((var(--sidenote-width) + var(--sidenote-gap)) * ${s.pageOffsetFactor});
				--sidenote-edge-offset: var(--sidenote-gap);
			}
			
			.markdown-source-view.mod-cm6[data-sidenote-mode="compact"],
			.markdown-reading-view[data-sidenote-mode="compact"] {
				--sidenote-base-width: ${Math.max(s.minSidenoteWidth - 2, 6)}rem;
				--sidenote-max-extra: ${Math.max((s.maxSidenoteWidth - s.minSidenoteWidth) / 2, 2)}rem;
				--sidenote-gap: ${Math.max(gap1 - 1, 0.5)}rem;
				--sidenote-gap2: ${Math.max(gap2 - 0.5, 0.25)}rem;
			}
			
			.markdown-source-view.mod-cm6[data-sidenote-mode="full"],
			.markdown-reading-view[data-sidenote-mode="full"] {
				--sidenote-base-width: ${s.maxSidenoteWidth}rem;
				--sidenote-max-extra: 2rem;
				--sidenote-gap: ${gap1 + 1}rem;
				--sidenote-gap2: ${gap2 + 0.5}rem;
			}
			
			.markdown-source-view.mod-cm6 .cm-scroller {
				overflow-y: auto !important;
				overflow-x: visible !important;
			}
			
			/* LEFT POSITION - page offset */
			.markdown-source-view.mod-cm6[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="compact"] .cm-scroller,
			.markdown-source-view.mod-cm6[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="normal"] .cm-scroller,
			.markdown-source-view.mod-cm6[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="full"] .cm-scroller {
				padding-left: var(--page-offset) !important;
				padding-right: 0 !important;
			}
			
			.markdown-reading-view[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="compact"] .markdown-preview-sizer,
			.markdown-reading-view[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="normal"] .markdown-preview-sizer,
			.markdown-reading-view[data-sidenote-position="left"][data-has-sidenotes="true"][data-sidenote-mode="full"] .markdown-preview-sizer {
				padding-left: var(--page-offset) !important;
				padding-right: 0 !important;
			}
			
			/* RIGHT POSITION - page offset */
			.markdown-source-view.mod-cm6[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="compact"] .cm-scroller,
			.markdown-source-view.mod-cm6[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="normal"] .cm-scroller,
			.markdown-source-view.mod-cm6[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="full"] .cm-scroller {
				padding-right: var(--page-offset) !important;
				padding-left: 0 !important;
			}
			
			.markdown-reading-view[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="compact"] .markdown-preview-sizer,
			.markdown-reading-view[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="normal"] .markdown-preview-sizer,
			.markdown-reading-view[data-sidenote-position="right"][data-has-sidenotes="true"][data-sidenote-mode="full"] .markdown-preview-sizer {
				padding-right: var(--page-offset) !important;
				padding-left: 0 !important;
			}
			
			${positioningStyles}
			
			.markdown-source-view.mod-cm6 .cm-editor,
			.markdown-source-view.mod-cm6 .cm-content,
			.markdown-source-view.mod-cm6 .cm-sizer,
			.markdown-source-view.mod-cm6 .cm-contentContainer {
				overflow: visible !important;
			}
			
			.markdown-source-view.mod-cm6 .cm-line {
				position: relative;
			}
			
			.markdown-reading-view p,
			.markdown-reading-view li,
			.markdown-reading-view h1,
			.markdown-reading-view h2,
			.markdown-reading-view h3,
			.markdown-reading-view h4,
			.markdown-reading-view h5,
			.markdown-reading-view h6,
			.markdown-reading-view blockquote,
			.markdown-reading-view .callout {
				position: relative;
			}
			
			.sidenote-number > span.sidenote {
				display: inline-block;
				width: 0;
				max-width: 0;
				overflow: hidden;
				white-space: nowrap;
				vertical-align: baseline;
			}
			
			.sidenote-margin {
				position: absolute;
				top: 0;
				width: var(--sidenote-width);
				font-size: ${s.fontSize}%;
				line-height: ${s.lineHeight};
				overflow-wrap: break-word;
				transform: translateY(calc(var(--sidenote-line-offset, 0px) + var(--sidenote-shift, 0px)));
				will-change: transform;
				z-index: 10;
				pointer-events: auto;
				${transitionRule}
			}
			
			.markdown-source-view.mod-cm6[data-sidenote-mode="compact"] .sidenote-margin,
			.markdown-reading-view[data-sidenote-mode="compact"] .sidenote-margin {
				font-size: ${s.fontSizeCompact}%;
				line-height: ${Math.max(s.lineHeight - 0.1, 1.1)};
			}
			
					/* Ensure margins don't overlap during transition */
					.markdown-reading-view .sidenote-margin,
					.markdown-source-view.mod-cm6 .sidenote-margin {
							isolation: isolate;
					}
							
			.markdown-source-view.mod-cm6[data-sidenote-mode="hidden"] .sidenote-margin,
			.markdown-reading-view[data-sidenote-mode="hidden"] .sidenote-margin {
				display: none;
			}
			
			.markdown-source-view.mod-cm6[data-sidenote-mode=""] .sidenote-margin,
			.markdown-reading-view[data-sidenote-mode=""] .sidenote-margin {
				opacity: 0;
				pointer-events: none;
			}
			
			/* Style internal links in sidenotes */
			.sidenote-margin a.internal-link {
				cursor: pointer;
			}

			/* Editable sidenote styling */
			.sidenote-margin[data-editing="true"] {
				background: var(--background-modifier-form-field);
				border-radius: 4px;
				padding: 4px 6px;
				outline: 2px solid var(--interactive-accent);
				cursor: text;
			}

			.sidenote-margin[data-editing="true"]::before {
				display: none;
			}

			.sidenote-margin[contenteditable="true"] {
				white-space: pre-wrap;
			}

			/* Markdown formatting in sidenotes */
			.sidenote-margin strong,
			.sidenote-margin b {
				font-weight: bold;
			}

			.sidenote-margin em,
			.sidenote-margin i {
				font-style: italic;
			}

			.sidenote-margin code {
				font-family: var(--font-monospace);
				font-size: 0.9em;
				background-color: var(--code-background);
				padding: 0.1em 0.3em;
				border-radius: 3px;
			}

			${plainNumberStyles}
			${neumorphicStyles}
			${pillStyles}

					/* Footnote-edit mode styles */
					${
						this.settings.sidenoteFormat === "footnote-edit"
							? `
					/* === LIVE PREVIEW MODE === */
					/* Hide footnote definitions - only in Live Preview */
					.markdown-source-view.mod-cm6.is-live-preview[data-has-sidenotes="true"][data-sidenote-mode="normal"] .cm-line.HyperMD-footnote,
					.markdown-source-view.mod-cm6.is-live-preview[data-has-sidenotes="true"][data-sidenote-mode="compact"] .cm-line.HyperMD-footnote,
					.markdown-source-view.mod-cm6.is-live-preview[data-has-sidenotes="true"][data-sidenote-mode="full"] .cm-line.HyperMD-footnote {
						/* display: none; */
					}

					/* Hide original [^1] reference - only in Live Preview */
					.markdown-source-view.mod-cm6.is-live-preview .cm-line:has(.sidenote-number[data-footnote-id]) .cm-footref {
						display: none;
					}

					/* === SOURCE MODE === */
					/* Hide sidenote widgets in Source mode - show raw markdown */
					.markdown-source-view.mod-cm6:not(.is-live-preview) .sidenote-number[data-footnote-id] {
						display: none;
					}

					/* Show the footnote reference in Source mode */
					.markdown-source-view.mod-cm6:not(.is-live-preview) .cm-footref {
						display: inline !important;
					}
					`
							: ""
					}

					/* CM6 footnote sidenote widget */
					.cm-line .sidenote-number[data-footnote-id] {
						position: static;
						display: inline;
					}

					/* Position margin relative to .cm-line, not the wrapper */
					.cm-line:has(.sidenote-number[data-footnote-id]) {
						position: relative;
					}

					.cm-line .sidenote-number[data-footnote-id] .sidenote-margin {
						position: absolute;
						top: 0;
						width: var(--sidenote-width);
						font-size: ${s.fontSize}%;
						line-height: ${s.lineHeight};
						overflow-wrap: break-word;
						transform: translateY(calc(var(--sidenote-line-offset, 0px) + var(--sidenote-shift, 0px)));
						will-change: transform;
						z-index: 10;
						pointer-events: auto;
						${transitionRule}
					}
		`;

		try {
			document.head.appendChild(this.styleEl);
		} catch (error) {
			console.error("Sidenote plugin: Failed to inject styles", error);
		}
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
		let sidenoteWidth = s.minSidenoteWidth * remToPx;

		if (sidenoteWidthStr) {
			const tempEl = document.createElement("div");
			tempEl.style.width = sidenoteWidthStr;
			tempEl.style.position = "absolute";
			tempEl.style.visibility = "hidden";
			root.appendChild(tempEl);
			sidenoteWidth = tempEl.getBoundingClientRect().width;
			tempEl.remove();
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

		if (mode === "hidden") return;

		// First, remove any existing sidenote markup in the reading root to start fresh
		this.removeAllSidenoteMarkupFromReadingMode(readingRoot);

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
			// Get footnote references
			const processedFootnoteIds = new Set<string>();

			// Find all footnote sups
			const footnoteSups =
				readingRoot.querySelectorAll<HTMLElement>("sup.footnote-ref");

			for (const sup of Array.from(footnoteSups)) {
				// Skip if already processed into a sidenote
				if (sup.closest(".sidenote-number")) continue;

				// Get the fn ID from the sup's data attribute or id
				const supDataId = sup.dataset.footnoteId ?? sup.id ?? "";

				// Convert fnref-X-HASH to fn-X-HASH to find the definition
				const fnId = supDataId.replace(/^fnref-/, "fn-");

				if (!fnId || processedFootnoteIds.has(fnId)) continue;
				processedFootnoteIds.add(fnId);

				// Find the footnote content by looking for li with matching id
				const footnoteLi = readingRoot.querySelector<HTMLElement>(
					`li[id="${fnId}"], li[data-footnote-id="${fnId}"]`,
				);

				if (!footnoteLi) continue;

				// Create a container to hold the footnote content
				const contentContainer = document.createElement("span");

				// Get the inner content - if there's a <p>, get its contents, otherwise get li contents
				const paragraph = footnoteLi.querySelector("p");
				const sourceElement = paragraph ?? footnoteLi;

				// Clone child nodes to preserve HTML formatting
				for (const child of Array.from(sourceElement.childNodes)) {
					const cloned = child.cloneNode(true);
					contentContainer.appendChild(cloned);
				}

				// Remove backref links from the cloned content
				contentContainer
					.querySelectorAll("a.footnote-backref, a[href^='#fnref']")
					.forEach((el) => el.remove());

				// Get text for sorting/fallback purposes
				const footnoteText = contentContainer.textContent?.trim();
				if (!footnoteText) continue;

				allItems.push({
					el: sup,
					rect: sup.getBoundingClientRect(),
					type: "footnote",
					text: footnoteText,
					footnoteId: fnId,
					footnoteHtml: contentContainer,
				});
			}
		}

		if (allItems.length === 0) {
			readingRoot.dataset.hasSidenotes = "false";
			return;
		}

		readingRoot.dataset.hasSidenotes = "true";

		// Sort by vertical position in document
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

			const numStr = this.formatNumber(num++);

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
				if (anchor) {
					(anchor as HTMLElement).style.display = "none";
				}

				// Clone the HTML content from the footnote, preserving formatting
				if (item.footnoteHtml) {
					this.cloneContentToMargin(item.footnoteHtml, margin);
				} else {
					margin.appendChild(
						this.renderLinksToFragment(this.normalizeText(item.text)),
					);
				}

				// Set up margin click-to-edit for footnotes
				if (item.footnoteId) {
					const footnoteId = item.footnoteId;

					// Initialize editing state
					margin.dataset.editing = "false";

					margin.addEventListener("mousedown", (e) => {
						// When editing, allow normal mousedown behavior for cursor positioning
						if (margin.contentEditable === "true") {
							return;
						}
						e.stopPropagation();
						e.preventDefault();
					});

					margin.addEventListener("click", (e) => {
						// When editing, allow normal click behavior
						if (margin.contentEditable === "true") {
							e.stopPropagation();
							return;
						}

						e.preventDefault();
						e.stopPropagation();
						this.startReadingModeMarginEdit(margin, footnoteId, e);
					});
				}
			}

			item.el.parentNode?.insertBefore(wrapper, item.el);
			wrapper.appendChild(item.el);
			wrapper.appendChild(margin);

			// Add click handler on wrapper to trigger margin editing (for footnote sidenotes)
			if (item.type === "footnote" && item.footnoteId) {
				const footnoteId = item.footnoteId;

				wrapper.addEventListener("click", (e) => {
					// Don't trigger if clicking on the margin itself
					if ((e.target as HTMLElement).closest(".sidenote-margin")) {
						return;
					}

					// Don't trigger if already editing
					if (margin.contentEditable === "true") {
						return;
					}

					e.preventDefault();
					e.stopPropagation();

					this.startReadingModeMarginEdit(margin, footnoteId);
				});

				wrapper.addEventListener("mousedown", (e) => {
					if ((e.target as HTMLElement).closest(".sidenote-margin")) {
						// If margin is being edited, allow normal behavior
						if (margin.contentEditable === "true") {
							return;
						}
					}
					e.stopPropagation();
				});
			}

			// Calculate line offset: how far down from the positioned parent is this reference?
			this.applyLineOffset(wrapper, margin, false);

			this.observeSidenoteVisibility(margin);
			marginNotes.push(margin);
		}

		// Run collision avoidance after DOM is fully settled
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (!readingRoot.isConnected) return;

				// Force reflow to ensure line offsets are applied
				void readingRoot.offsetHeight;

				// Calculate and apply sidenote positioning
				this.updateSidenotePositioning(readingRoot, true);

				this.resolveCollisions(
					marginNotes.filter((m) => m.isConnected),
					this.settings.collisionSpacing,
				);
			});
		});
	}

	private scheduleFootnoteProcessing() {
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
			if (!readingRoot) return;

			// Check if we have both refs and definitions
			const hasRefs =
				readingRoot.querySelectorAll(
					"sup.footnote-ref, sup[data-footnote-id]",
				).length > 0;

			const hasDefs =
				readingRoot.querySelectorAll("section.footnotes li, .footnotes li")
					.length > 0;

			if (hasRefs && hasDefs) {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						this.processReadingModeSidenotes(readingRoot);
					});
				});
			} else if (hasRefs) {
				// Refs exist but no definitions yet - try again later
				this.scheduleFootnoteProcessing();
			}
		}, 150); // Longer delay to allow footnotes section to render
	}

	/**
	 * Start editing a footnote sidenote margin in reading mode.
	 */
	private startReadingModeMarginEdit(
		margin: HTMLElement,
		footnoteId: string,
		clickEvent?: MouseEvent,
	) {
		// Don't re-initialize if already editing
		if (margin.contentEditable === "true") {
			// If we have a click event, just position the cursor
			if (clickEvent) {
				this.placeCursorAtClickPosition(margin, clickEvent);
			}
			return;
		}

		margin.dataset.editing = "true";

		// Get the current content
		const currentText = margin.textContent ?? "";

		// Clear margin and make it editable
		margin.innerHTML = "";
		margin.contentEditable = "true";
		margin.textContent = currentText;
		margin.focus();

		// Place cursor at click position, or at end if no click event
		if (clickEvent) {
			this.placeCursorAtClickPosition(margin, clickEvent);
		} else {
			// Place cursor at end
			const selection = window.getSelection();
			const range = document.createRange();
			range.selectNodeContents(margin);
			range.collapse(false);
			selection?.removeAllRanges();
			selection?.addRange(range);
		}

		const onKeyDown = (e: KeyboardEvent) => {
			e.stopPropagation();
			e.stopImmediatePropagation();

			const isMod = e.ctrlKey || e.metaKey;

			// Handle formatting shortcuts
			if (isMod) {
				const key = e.key.toLowerCase();

				if (key === "b") {
					e.preventDefault();
					this.applyMarkdownFormatting(margin, "**");
					return;
				}
				if (key === "i") {
					e.preventDefault();
					this.applyMarkdownFormatting(margin, "*");
					return;
				}
				if (key === "k") {
					e.preventDefault();
					this.applyMarkdownFormatting(margin, "", "", true);
					return;
				}
				if (key === "a") {
					e.preventDefault();
					const selection = window.getSelection();
					const range = document.createRange();
					range.selectNodeContents(margin);
					selection?.removeAllRanges();
					selection?.addRange(range);
					return;
				}
			}

			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				margin.blur();
				return;
			}

			if (e.key === "Escape") {
				e.preventDefault();
				margin.dataset.editing = "false";
				margin.contentEditable = "false";
				margin.innerHTML = "";
				margin.appendChild(
					this.renderLinksToFragment(this.normalizeText(currentText)),
				);
				margin.removeEventListener("blur", onBlur);
				margin.removeEventListener("keydown", onKeyDown);
				margin.removeEventListener("keyup", onKeyUp);
				margin.removeEventListener("keypress", onKeyPress);
				return;
			}

			// Handle arrow keys - prevent cursor from leaving the margin
			if (
				["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
			) {
				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) return;

				const range = selection.getRangeAt(0);

				// Check if at start
				const atStart =
					range.collapsed &&
					range.startOffset === 0 &&
					(range.startContainer === margin ||
						range.startContainer === margin.firstChild);

				// Check if at end
				let atEnd = false;
				if (range.collapsed) {
					if (range.startContainer === margin) {
						atEnd = range.startOffset === margin.childNodes.length;
					} else if (range.startContainer.nodeType === Node.TEXT_NODE) {
						const containerLength =
							range.startContainer.textContent?.length ?? 0;
						atEnd =
							range.startOffset === containerLength &&
							(range.startContainer === margin.lastChild ||
								range.startContainer.parentNode === margin);
					}
				}

				// Block left/right movement out of the margin
				if (atStart && e.key === "ArrowLeft") {
					e.preventDefault();
					return;
				}
				if (atEnd && e.key === "ArrowRight") {
					e.preventDefault();
					return;
				}

				// For up/down, we need to check if the movement would leave the margin
				if (e.key === "ArrowUp" || e.key === "ArrowDown") {
					// Get current cursor position
					const cursorRect = range.getBoundingClientRect();
					const marginRect = margin.getBoundingClientRect();

					// Check if we're on the first line (for ArrowUp) or last line (for ArrowDown)
					const lineHeight =
						parseFloat(getComputedStyle(margin).lineHeight) || 20;

					if (e.key === "ArrowUp") {
						// If cursor is near the top of the margin, block
						if (cursorRect.top - marginRect.top < lineHeight) {
							e.preventDefault();
							return;
						}
					}

					if (e.key === "ArrowDown") {
						// If cursor is near the bottom of the margin, block
						if (marginRect.bottom - cursorRect.bottom < lineHeight) {
							e.preventDefault();
							return;
						}
					}
				}
			}
		};

		const onKeyUp = (e: KeyboardEvent) => {
			e.stopPropagation();
		};

		const onKeyPress = (e: KeyboardEvent) => {
			e.stopPropagation();
		};

		const onBlur = () => {
			this.finishReadingModeMarginEdit(margin, footnoteId, currentText);
			margin.removeEventListener("blur", onBlur);
			margin.removeEventListener("keydown", onKeyDown);
			margin.removeEventListener("keyup", onKeyUp);
			margin.removeEventListener("keypress", onKeyPress);
		};

		margin.addEventListener("blur", onBlur);
		margin.addEventListener("keydown", onKeyDown);
		margin.addEventListener("keyup", onKeyUp);
		margin.addEventListener("keypress", onKeyPress);
	}

	/**
	 * Finish editing a footnote sidenote margin in reading mode and save to source.
	 */
	private finishReadingModeMarginEdit(
		margin: HTMLElement,
		footnoteId: string,
		originalText: string,
	) {
		const newText = margin.textContent ?? "";

		margin.dataset.editing = "false";
		margin.contentEditable = "false";

		// Restore rendered content
		margin.innerHTML = "";
		margin.appendChild(
			this.renderLinksToFragment(this.normalizeText(newText)),
		);

		// If no change, we're done
		if (newText === originalText) {
			return;
		}

		// Update the source document
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.editor) return;

		const editor = view.editor;
		const content = editor.getValue();

		// The footnoteId from reading mode is like "fn-1-abc123", we need just the number/id part
		// Extract the actual footnote identifier - try multiple patterns
		let actualId = footnoteId;

		// Pattern 1: fn-X-HASH
		const fnHashMatch = footnoteId.match(/^fn-(.+?)-[a-f0-9]+$/i);
		if (fnHashMatch && fnHashMatch[1]) {
			actualId = fnHashMatch[1];
		} else {
			// Pattern 2: fn-X
			const fnMatch = footnoteId.match(/^fn-(.+)$/i);
			if (fnMatch && fnMatch[1]) {
				actualId = fnMatch[1];
			}
		}

		console.log(
			"Reading mode: footnoteId =",
			footnoteId,
			"actualId =",
			actualId,
		);

		// Find and replace the footnote definition
		const escapedId = actualId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const footnoteDefRegex = new RegExp(
			`^(\\[\\^${escapedId}\\]:\\s*)(.*)$`,
			"gm",
		);

		const match = footnoteDefRegex.exec(content);
		console.log("Reading mode: match =", match);

		if (match) {
			const prefix = match[1] ?? "";
			const from = editor.offsetToPos(match.index + prefix.length);
			const to = editor.offsetToPos(match.index + match[0].length);

			editor.replaceRange(newText, from, to);
			console.log("Reading mode: replaced successfully");
		} else {
			console.log("Reading mode: no match found for [^" + actualId + "]:");
		}
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
			const line = wrapper.closest(".cm-line") as HTMLElement | null;
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
			// Reading mode: find the positioned ancestor (p, li, etc.)
			const positionedParent = wrapper.offsetParent as HTMLElement | null;
			if (!positionedParent) return;

			// Get the wrapper's position relative to its offset parent
			const wrapperRect = wrapper.getBoundingClientRect();
			const parentRect = positionedParent.getBoundingClientRect();

			// Calculate the offset from the top of the parent to the wrapper
			const lineOffset = wrapperRect.top - parentRect.top;

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
			const footnoteSup =
				wrapper.querySelector<HTMLElement>("sup.footnote-ref");
			const originalEl = sidenoteSpan ?? footnoteSup;

			// Restore footnote link visibility if needed
			if (footnoteSup) {
				const link = footnoteSup.querySelector<HTMLElement>("a");
				if (link) {
					link.style.display = "";
				}
			}

			// Clean up margin
			const margin = wrapper.querySelector<HTMLElement>(
				"small.sidenote-margin",
			);
			if (margin) {
				if ((margin as any)._sidenoteCleanup) {
					(margin as any)._sidenoteCleanup();
					delete (margin as any)._sidenoteCleanup;
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
					this.app.workspace.openLinkText(linkTarget, "", false);
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
			this.cleanups.push(() => {
				readingScroller.removeEventListener("scroll", onReadingScroll);
				if (this.readingModeScrollTimer !== null) {
					window.clearTimeout(this.readingModeScrollTimer);
					this.readingModeScrollTimer = null;
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

		const editor = (view.editor as any)?.cm as any;
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
				if ((margin as any)._sidenoteCleanup) {
					(margin as any)._sidenoteCleanup();
					delete (margin as any)._sidenoteCleanup;
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
						this.app.workspace.openLinkText(url, "", false);
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
					this.app.workspace.openLinkText(target, "", false);
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
		(margin as any)._sidenoteCleanup = () => {
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
		// Don't re-initialize if already editing
		if (
			margin.dataset.editing === "true" &&
			margin.contentEditable === "true"
		) {
			return;
		}

		margin.dataset.editing = "true";

		// Get the raw text content (without the number prefix)
		const currentText = sourceSpan.textContent ?? "";

		// Clear margin and make it a simple text editor
		margin.innerHTML = "";
		margin.contentEditable = "true";
		margin.textContent = currentText;
		margin.focus();

		// Place cursor at click position, or at end if no click event
		if (clickEvent) {
			this.placeCursorAtClickPosition(margin, clickEvent);
		} else {
			// Place cursor at end
			const selection = window.getSelection();
			const range = document.createRange();
			range.selectNodeContents(margin);
			range.collapse(false);
			selection?.removeAllRanges();
			selection?.addRange(range);
		}

		// Handle blur (save changes)
		const onBlur = () => {
			this.finishMarginEdit(margin, sourceSpan, sidenoteIndex);
			margin.removeEventListener("blur", onBlur);
			margin.removeEventListener("keydown", onKeydown);
		};

		// Handle keyboard
		const onKeydown = (e: KeyboardEvent) => {
			e.stopPropagation();
			e.stopImmediatePropagation();

			const isMod = e.ctrlKey || e.metaKey;

			// Handle formatting shortcuts
			if (isMod) {
				const key = e.key.toLowerCase();

				if (key === "b") {
					e.preventDefault();
					this.applyMarkdownFormatting(margin, "**");
					return;
				}
				if (key === "i") {
					e.preventDefault();
					this.applyMarkdownFormatting(margin, "*");
					return;
				}
				if (key === "k") {
					e.preventDefault();
					this.applyMarkdownFormatting(margin, "", "", true);
					return;
				}
				if (key === "a") {
					e.preventDefault();
					const selection = window.getSelection();
					const range = document.createRange();
					range.selectNodeContents(margin);
					selection?.removeAllRanges();
					selection?.addRange(range);
					return;
				}
			}

			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				margin.blur();
				return;
			}

			if (e.key === "Escape") {
				e.preventDefault();
				// Restore original content without saving
				margin.dataset.editing = "false";
				margin.contentEditable = "false";
				margin.innerHTML = "";
				margin.appendChild(
					this.renderLinksToFragment(
						this.normalizeText(sourceSpan.textContent ?? ""),
					),
				);
				margin.removeEventListener("blur", onBlur);
				margin.removeEventListener("keydown", onKeydown);
				return;
			}

			// Handle arrow keys - prevent cursor from leaving the margin
			if (
				["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
			) {
				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) return;

				const range = selection.getRangeAt(0);

				// Check if at start
				const atStart =
					range.collapsed &&
					range.startOffset === 0 &&
					(range.startContainer === margin ||
						range.startContainer === margin.firstChild);

				// Check if at end
				let atEnd = false;
				if (range.collapsed) {
					if (range.startContainer === margin) {
						atEnd = range.startOffset === margin.childNodes.length;
					} else if (range.startContainer.nodeType === Node.TEXT_NODE) {
						const containerLength =
							range.startContainer.textContent?.length ?? 0;
						atEnd =
							range.startOffset === containerLength &&
							(range.startContainer === margin.lastChild ||
								range.startContainer.parentNode === margin);
					}
				}

				// Block left/right movement out of the margin
				if (atStart && e.key === "ArrowLeft") {
					e.preventDefault();
					return;
				}
				if (atEnd && e.key === "ArrowRight") {
					e.preventDefault();
					return;
				}

				// For up/down, we need to check if the movement would leave the margin
				if (e.key === "ArrowUp" || e.key === "ArrowDown") {
					// Get current cursor position
					const cursorRect = range.getBoundingClientRect();
					const marginRect = margin.getBoundingClientRect();

					// Check if we're on the first line (for ArrowUp) or last line (for ArrowDown)
					const lineHeight =
						parseFloat(getComputedStyle(margin).lineHeight) || 20;

					if (e.key === "ArrowUp") {
						// If cursor is near the top of the margin, block
						if (cursorRect.top - marginRect.top < lineHeight) {
							e.preventDefault();
							return;
						}
					}

					if (e.key === "ArrowDown") {
						// If cursor is near the bottom of the margin, block
						if (marginRect.bottom - cursorRect.bottom < lineHeight) {
							e.preventDefault();
							return;
						}
					}
				}
			}
		};

		margin.addEventListener("blur", onBlur);
		margin.addEventListener("keydown", onKeydown);
	}

	/**
	 * Place the cursor at the position where the user clicked within a contenteditable element.
	 */
	private placeCursorAtClickPosition(
		element: HTMLElement,
		clickEvent: MouseEvent,
	) {
		const selection = window.getSelection();
		if (!selection) return;

		// Use caretRangeFromPoint or caretPositionFromPoint depending on browser support
		let range: Range | null = null;

		if (document.caretRangeFromPoint) {
			// Chrome, Safari, Edge
			range = document.caretRangeFromPoint(
				clickEvent.clientX,
				clickEvent.clientY,
			);
		} else if ((document as any).caretPositionFromPoint) {
			// Firefox
			const caretPos = (document as any).caretPositionFromPoint(
				clickEvent.clientX,
				clickEvent.clientY,
			);
			if (caretPos) {
				range = document.createRange();
				range.setStart(caretPos.offsetNode, caretPos.offset);
				range.collapse(true);
			}
		}

		if (range) {
			selection.removeAllRanges();
			selection.addRange(range);
		} else {
			// Fallback: place cursor at end
			range = document.createRange();
			range.selectNodeContents(element);
			range.collapse(false);
			selection.removeAllRanges();
			selection.addRange(range);
		}
	}

	/**
	 * Finish editing and save changes to the source document.
	 * Uses sidenote index for reliable identification.
	 */
	private finishMarginEdit(
		margin: HTMLElement,
		sourceSpan: HTMLElement,
		sidenoteIndex: number,
	) {
		const newText = margin.textContent ?? "";
		const oldText = sourceSpan.textContent ?? "";

		margin.dataset.editing = "false";
		margin.contentEditable = "false";

		// If no change, just restore the rendered content
		if (newText === oldText) {
			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(newText)),
			);
			return;
		}

		// Update the source document
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.editor) {
			// Restore display even if we can't save
			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(newText)),
			);
			return;
		}

		const editor = view.editor;

		// Save scroll position before making changes
		const scroller =
			this.cmRoot?.querySelector<HTMLElement>(".cm-scroller");
		const scrollTop = scroller?.scrollTop ?? 0;

		// Set flag to prevent layout from interfering
		this.isEditingMargin = true;

		const content = editor.getValue();

		// Find the Nth sidenote in the source (using sidenoteIndex)
		const sidenoteRegex =
			/<span\s+class\s*=\s*["']sidenote["'][^>]*>([\s\S]*?)<\/span>/gi;

		let match: RegExpExecArray | null;
		let currentIndex = 0;
		let found = false;

		while ((match = sidenoteRegex.exec(content)) !== null) {
			currentIndex++;

			if (currentIndex === sidenoteIndex) {
				// This is the sidenote we want to edit
				const from = editor.offsetToPos(match.index);
				const to = editor.offsetToPos(match.index + match[0].length);
				const newSpan = `<span class="sidenote">${newText}</span>`;

				this.isMutating = true;
				try {
					editor.replaceRange(newSpan, from, to);
				} finally {
					this.isMutating = false;
				}

				found = true;
				break;
			}
		}

		// Restore scroll position after edit
		const restoreState = () => {
			if (scroller) {
				scroller.scrollTop = scrollTop;
			}
			this.isEditingMargin = false;
		};

		if (found) {
			// Use multiple RAFs to ensure we restore after all updates
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					restoreState();
				});
			});
		} else {
			restoreState();
			// Couldn't find the sidenote to update, just restore the margin display
			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(newText)),
			);
		}
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
			margin.style.setProperty("--sidenote-shift", "0px");
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
				item.el.style.setProperty("--sidenote-shift", "0px");
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

		containerEl.createEl("h2", { text: "Display" });

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

		new Setting(containerEl)
			.setName("Sidenote format")
			.setDesc("Choose how sidenotes are written in your documents")
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						"html",
						'HTML spans: <span class="sidenote">text</span>',
					)
					.addOption("footnote", "Footnotes (reading mode only)")
					.addOption(
						"footnote-edit",
						"Footnotes (reading + editing mode) [experimental]",
					)
					.setValue(this.plugin.settings.sidenoteFormat)
					.onChange(
						async (value: "html" | "footnote" | "footnote-edit") => {
							this.plugin.settings.sidenoteFormat = value;
							await this.plugin.saveSettings();
						},
					),
			);

		containerEl.createEl("h2", { text: "Width & Spacing" });

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

		containerEl.createEl("h2", { text: "Breakpoints" });

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

		containerEl.createEl("h2", { text: "Typography" });

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

		containerEl.createEl("h2", { text: "Behavior" });

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
		containerEl.createEl("h2", { text: "Formatting Help" });

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

	private setupMarginEditing(margin: HTMLElement) {
		margin.dataset.editing = "false";

		// Check if this footnote is already being edited (widget was recreated)
		if (this.plugin.getActiveFootnoteEdit() === this.footnoteId) {
			// Restore editing state
			margin.dataset.editing = "true";
			margin.contentEditable = "true";
			margin.innerHTML = "";
			margin.textContent = this.content;

			// Re-setup event listeners
			this.attachEditingListeners(margin);

			// Set up click handlers that just handle cursor positioning (already editing)
			margin.addEventListener("mousedown", (e: MouseEvent) => {
				// Allow normal behavior for cursor positioning
				e.stopPropagation();
			});

			margin.addEventListener("click", (e: MouseEvent) => {
				e.stopPropagation();
				// Cursor positioning is handled by the browser
			});

			// Focus and place cursor at end
			requestAnimationFrame(() => {
				margin.focus();
			});
			return;
		}

		const onMouseDown = (e: MouseEvent) => {
			if (margin.contentEditable === "true") {
				// Allow normal behavior but stop propagation to CM6
				e.stopPropagation();
				return;
			}
			e.stopPropagation();
			e.preventDefault();
		};

		const onClick = (e: MouseEvent) => {
			if (margin.contentEditable === "true") {
				e.stopPropagation();
				return;
			}

			e.preventDefault();
			e.stopPropagation();
			this.startMarginEdit(margin, e);
		};

		margin.addEventListener("mousedown", onMouseDown);
		margin.addEventListener("click", onClick);
	}

	private startMarginEdit(margin: HTMLElement, clickEvent?: MouseEvent) {
		// Don't re-initialize if already editing
		if (margin.contentEditable === "true") {
			if (clickEvent) {
				this.placeCursorAtClickPosition(margin, clickEvent);
			}
			return;
		}

		// Mark this footnote as being edited
		this.plugin.setActiveFootnoteEdit(this.footnoteId);

		margin.dataset.editing = "true";

		const currentText = this.content;

		margin.innerHTML = "";
		margin.contentEditable = "true";
		margin.textContent = currentText;
		margin.focus();

		if (clickEvent) {
			this.placeCursorAtClickPosition(margin, clickEvent);
		} else {
			const selection = window.getSelection();
			const range = document.createRange();
			range.selectNodeContents(margin);
			range.collapse(false);
			selection?.removeAllRanges();
			selection?.addRange(range);
		}

		this.attachEditingListeners(margin);
	}

	private attachEditingListeners(margin: HTMLElement) {
		const onKeyDown = (e: KeyboardEvent) => {
			e.stopPropagation();
			e.stopImmediatePropagation();

			const isMod = e.ctrlKey || e.metaKey;

			// Handle formatting shortcuts
			if (isMod) {
				const key = e.key.toLowerCase();

				if (key === "b") {
					e.preventDefault();
					this.plugin.applyMarkdownFormattingPublic(margin, "**");
					return;
				}
				if (key === "i") {
					e.preventDefault();
					this.plugin.applyMarkdownFormattingPublic(margin, "*");
					return;
				}
				if (key === "k") {
					e.preventDefault();
					this.plugin.applyMarkdownFormattingPublic(margin, "", "", true);
					return;
				}
				if (key === "a") {
					e.preventDefault();
					const selection = window.getSelection();
					const range = document.createRange();
					range.selectNodeContents(margin);
					selection?.removeAllRanges();
					selection?.addRange(range);
					return;
				}
			}

			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				margin.blur();
				return;
			}

			if (e.key === "Escape") {
				e.preventDefault();
				this.cancelEdit(margin);
				return;
			}

			// Handle arrow keys - prevent cursor from leaving the margin
			if (
				["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
			) {
				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) return;

				const range = selection.getRangeAt(0);

				// Check if at start
				const atStart =
					range.collapsed &&
					range.startOffset === 0 &&
					(range.startContainer === margin ||
						range.startContainer === margin.firstChild);

				// Check if at end
				let atEnd = false;
				if (range.collapsed) {
					if (range.startContainer === margin) {
						atEnd = range.startOffset === margin.childNodes.length;
					} else if (range.startContainer.nodeType === Node.TEXT_NODE) {
						const containerLength =
							range.startContainer.textContent?.length ?? 0;
						atEnd =
							range.startOffset === containerLength &&
							(range.startContainer === margin.lastChild ||
								range.startContainer.parentNode === margin);
					}
				}

				// Block left/right movement out of the margin
				if (atStart && e.key === "ArrowLeft") {
					e.preventDefault();
					return;
				}
				if (atEnd && e.key === "ArrowRight") {
					e.preventDefault();
					return;
				}

				// For up/down, we need to check if the movement would leave the margin
				if (e.key === "ArrowUp" || e.key === "ArrowDown") {
					// Get current cursor position
					const cursorRect = range.getBoundingClientRect();
					const marginRect = margin.getBoundingClientRect();

					// Check if we're on the first line (for ArrowUp) or last line (for ArrowDown)
					const lineHeight =
						parseFloat(getComputedStyle(margin).lineHeight) || 20;

					if (e.key === "ArrowUp") {
						// If cursor is near the top of the margin, block
						if (cursorRect.top - marginRect.top < lineHeight) {
							e.preventDefault();
							return;
						}
					}

					if (e.key === "ArrowDown") {
						// If cursor is near the bottom of the margin, block
						if (marginRect.bottom - cursorRect.bottom < lineHeight) {
							e.preventDefault();
							return;
						}
					}
				}
			}
		};

		const onKeyUp = (e: KeyboardEvent) => {
			e.stopPropagation();
			e.stopImmediatePropagation();
		};

		const onKeyPress = (e: KeyboardEvent) => {
			e.stopPropagation();
			e.stopImmediatePropagation();
		};

		const onBlur = () => {
			this.finishMarginEdit(margin);
			margin.removeEventListener("blur", onBlur);
			margin.removeEventListener("keydown", onKeyDown);
			margin.removeEventListener("keyup", onKeyUp);
			margin.removeEventListener("keypress", onKeyPress);
		};

		margin.addEventListener("blur", onBlur);
		margin.addEventListener("keydown", onKeyDown);
		margin.addEventListener("keyup", onKeyUp);
		margin.addEventListener("keypress", onKeyPress);
	}

	private cancelEdit(margin: HTMLElement) {
		margin.dataset.editing = "false";
		margin.contentEditable = "false";
		margin.innerHTML = "";
		margin.appendChild(
			this.plugin.renderLinksToFragmentPublic(
				this.plugin.normalizeTextPublic(this.content),
			),
		);
		this.plugin.setActiveFootnoteEdit(null);
	}

	/**
	 * Place the cursor at the position where the user clicked within a contenteditable element.
	 */
	private placeCursorAtClickPosition(
		element: HTMLElement,
		clickEvent: MouseEvent,
	) {
		const selection = window.getSelection();
		if (!selection) return;

		let range: Range | null = null;

		if (document.caretRangeFromPoint) {
			range = document.caretRangeFromPoint(
				clickEvent.clientX,
				clickEvent.clientY,
			);
		} else if ((document as any).caretPositionFromPoint) {
			const caretPos = (document as any).caretPositionFromPoint(
				clickEvent.clientX,
				clickEvent.clientY,
			);
			if (caretPos) {
				range = document.createRange();
				range.setStart(caretPos.offsetNode, caretPos.offset);
				range.collapse(true);
			}
		}

		if (range) {
			selection.removeAllRanges();
			selection.addRange(range);
		} else {
			range = document.createRange();
			range.selectNodeContents(element);
			range.collapse(false);
			selection.removeAllRanges();
			selection.addRange(range);
		}
	}

	private finishMarginEdit(margin: HTMLElement) {
		const newText = margin.textContent ?? "";

		margin.dataset.editing = "false";
		margin.contentEditable = "false";

		// Clear the active edit tracking so decorations can rebuild
		this.plugin.setActiveFootnoteEdit(null);

		if (newText === this.content) {
			margin.innerHTML = "";
			margin.appendChild(
				this.plugin.renderLinksToFragmentPublic(
					this.plugin.normalizeTextPublic(newText),
				),
			);
			return;
		}

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
			// Let CM6 rebuild the widget with new content - don't update margin manually
			return;
		}

		// Only reach here if we couldn't find the footnote definition
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
