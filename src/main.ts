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

	// Footnote conversion
	convertFootnotes: "off" | "reading" | "both";
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
	pageOffsetFactor: 0.8,

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

	// Footnote conversion
	convertFootnotes: "off",
};

// Regex to detect sidenote spans in source text
const SIDENOTE_PATTERN = /<span\s+class\s*=\s*["']sidenote["'][^>]*>/gi;

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

	// Performance: Collision avoidance caching
	private lastCollisionHash: string = "";

	// Performance: Visible sidenotes tracking
	private visibilityObserver: IntersectionObserver | null = null;
	private visibleSidenotes: Set<HTMLElement> = new Set();

	private totalSidenotesInDocument = 0;
	private isEditingMargin = false;

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

				if (selectedText) {
					// Wrap selected text in sidenote tags
					editor.replaceSelection(
						`<span class="sidenote">${selectedText}</span>`,
					);
				} else {
					// Insert empty sidenote tags and place cursor inside
					const sidenoteText = '<span class="sidenote"></span>';
					editor.replaceRange(sidenoteText, cursor);

					// Move cursor to between the tags (before </span>)
					const newCursor = {
						line: cursor.line,
						ch: cursor.ch + '<span class="sidenote">'.length,
					};
					editor.setCursor(newCursor);
				}
			},
		});

		this.registerMarkdownPostProcessor((element, context) => {
			const sidenoteSpans =
				element.querySelectorAll<HTMLElement>("span.sidenote");

			// Check for footnotes if conversion is enabled
			const hasFootnotes =
				this.settings.convertFootnotes !== "off" &&
				element.querySelectorAll("sup.footnote-ref, section.footnotes")
					.length > 0;

			if (sidenoteSpans.length > 0 || hasFootnotes) {
				// Use a longer delay to ensure footnotes section is rendered
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						this.processReadingModeSidenotes(element);
					});
				});
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
				this.lastCollisionHash = "";
				this.scheduleLayoutDebounced(100);
			}),
		);
		this.registerDomEvent(window, "resize", () => {
			this.scheduleLayoutThrottled(100);
			this.scheduleReadingModeLayoutThrottled(100);
		});

		this.scanDocumentForSidenotes();
		this.rebindAndSchedule();
	}

	onunload() {
		this.cancelAllTimers();
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

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
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.injectStyles();
		this.updatePositionDataAttributes();
		this.invalidateLayoutCache();
		this.scheduleLayout();
		this.scheduleReadingModeLayout();
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
		this.lastCollisionHash = "";
	}

	private scheduleLayoutDebounced(delay: number = 50) {
		if (this.mutationDebounceTimer !== null) {
			window.clearTimeout(this.mutationDebounceTimer);
		}
		this.mutationDebounceTimer = window.setTimeout(() => {
			this.mutationDebounceTimer = null;
			this.scheduleLayout();
		}, delay);
	}

	private scheduleLayoutThrottled(minInterval: number = 100) {
		const now = Date.now();
		if (now - this.resizeThrottleTime >= minInterval) {
			this.resizeThrottleTime = now;
			this.scheduleLayout();
		}
	}

	private scheduleReadingModeLayoutThrottled(minInterval: number = 100) {
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

	private scheduleCollisionUpdate() {
		if (this.rafId !== null) return;
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.updateVisibleCollisions();
		});
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

	private updatePositionDataAttributes() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const cmRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (cmRoot) {
			cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;
		}

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;
		}
	}

	// ==================== Style Injection ====================

	private injectStyles() {
		if (this.styleEl) {
			this.styleEl.remove();
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
            --sn-badge-bg: rgba(255, 255, 255, 0.05);
            --sn-badge-text: var(--text-muted);
            --sn-badge-border: rgba(255, 255, 255, 0.1);
            --sn-active-bg: var(--interactive-accent);
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
            border-color: transparent !important;
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
            --sidenote-gap: ${s.sidenoteGap}rem;
            --page-offset: calc((var(--sidenote-width) + var(--sidenote-gap)) * ${s.pageOffsetFactor});
        }
        
        .markdown-source-view.mod-cm6[data-sidenote-mode="compact"],
        .markdown-reading-view[data-sidenote-mode="compact"] {
            --sidenote-base-width: ${Math.max(s.minSidenoteWidth - 2, 6)}rem;
            --sidenote-max-extra: ${Math.max((s.maxSidenoteWidth - s.minSidenoteWidth) / 2, 2)}rem;
            --sidenote-gap: ${Math.max(s.sidenoteGap - 1, 0.5)}rem;
        }
        
        .markdown-source-view.mod-cm6[data-sidenote-mode="full"],
        .markdown-reading-view[data-sidenote-mode="full"] {
            --sidenote-base-width: ${s.maxSidenoteWidth}rem;
            --sidenote-max-extra: 2rem;
            --sidenote-gap: ${s.sidenoteGap + 1}rem;
        }
        
        .markdown-source-view.mod-cm6 .cm-scroller {
            overflow-y: auto !important;
            overflow-x: visible !important;
        }
        
        /* LEFT POSITION */
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
        
        .markdown-source-view.mod-cm6[data-sidenote-position="left"] .sidenote-margin,
        .markdown-reading-view[data-sidenote-position="left"] .sidenote-margin {
            left: calc(-1 * (var(--sidenote-width) + var(--sidenote-gap)));
            right: auto;
            text-align: ${textAlign};
        }
        
        /* RIGHT POSITION */
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
        
        .markdown-source-view.mod-cm6[data-sidenote-position="right"] .sidenote-margin,
        .markdown-reading-view[data-sidenote-position="right"] .sidenote-margin {
            right: calc(-1 * (var(--sidenote-width) + var(--sidenote-gap)));
            left: auto;
            text-align: ${textAlign};
        }
        
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
            top: 0.2em;
            width: var(--sidenote-width);
            font-size: ${s.fontSize}%;
            line-height: ${s.lineHeight};
            overflow-wrap: break-word;
            transform: translateY(var(--sidenote-shift, 0px));
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

				/* Hide footnotes section when converting to sidenotes */
				${
					this.settings.convertFootnotes !== "off"
						? `
				section.footnotes {
						/* Only hide when sidenotes are visible */
				}
				.markdown-reading-view[data-has-sidenotes="true"][data-sidenote-mode="normal"] section.footnotes,
				.markdown-reading-view[data-has-sidenotes="true"][data-sidenote-mode="compact"] section.footnotes,
				.markdown-reading-view[data-has-sidenotes="true"][data-sidenote-mode="full"] section.footnotes {
						display: none;
				}

				/* Hide the original footnote number text when converted to sidenote */
				.sidenote-number sup.footnote-ref a.footnote-link {
						display: none;
				}
				`
						: ""
				}

				/* CM6 footnote sidenote widget */
				.cm-line .sidenote-number[data-footnote-id] {
						position: relative;
						display: inline;
				}

				.cm-line .sidenote-number[data-footnote-id] .sidenote-margin {
						position: absolute;
						top: 0;
						width: var(--sidenote-width);
				}

				.markdown-source-view.mod-cm6[data-sidenote-position="left"] .cm-line .sidenote-number[data-footnote-id] .sidenote-margin {
						left: calc(-1 * (var(--sidenote-width) + var(--sidenote-gap)));
						right: auto;
				}

				.markdown-source-view.mod-cm6[data-sidenote-position="right"] .cm-line .sidenote-number[data-footnote-id] .sidenote-margin {
						right: calc(-1 * (var(--sidenote-width) + var(--sidenote-gap)));
						left: auto;
				}

				/* Hide original footnote reference when converted */
				.cm-line .sidenote-number[data-footnote-id] + .cm-footref,
				.cm-line .sidenote-number[data-footnote-id] ~ .cm-footref {
						/* Keep visible but we add our number */
				}
    `;

		document.head.appendChild(this.styleEl);
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
		return result;
	}

	private toLetters(num: number): string {
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
		readingRoot.dataset.hasSidenotes = "true";
		readingRoot.dataset.sidenotePosition = this.settings.sidenotePosition;

		const scaleFactor = this.calculateScaleFactor(width);
		readingRoot.style.setProperty(
			"--sidenote-scale",
			scaleFactor.toFixed(3),
		);

		if (mode === "hidden") return;

		// First, remove any existing sidenote markup in the reading root to start fresh
		this.removeAllSidenoteMarkupFromReadingMode(readingRoot);

		// Collect ALL items from the entire reading root
		const allItems: {
			el: HTMLElement;
			rect: DOMRect;
			type: "sidenote" | "footnote";
			text: string;
			footnoteId?: string;
		}[] = [];

		// Get ALL sidenote spans from the reading root
		const spans = Array.from(
			readingRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) => !span.parentElement?.classList.contains("sidenote-number"),
		);

		for (const el of spans) {
			allItems.push({
				el,
				rect: el.getBoundingClientRect(),
				type: "sidenote",
				text: el.textContent ?? "",
			});
		}

		// Get footnote references if conversion is enabled
		if (this.settings.convertFootnotes !== "off") {
			const processedFootnoteIds = new Set<string>();

			// Find all footnote sups
			const footnoteSups =
				readingRoot.querySelectorAll<HTMLElement>("sup.footnote-ref");

			for (const sup of Array.from(footnoteSups)) {
				// Skip if already processed into a sidenote
				if (sup.closest(".sidenote-number")) continue;

				// Get the fn ID from the sup's data attribute
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

				// Extract text, removing the backref link
				const clone = footnoteLi.cloneNode(true) as HTMLElement;
				clone
					.querySelectorAll("a.footnote-backref, a[href^='#fnref']")
					.forEach((el) => el.remove());
				const footnoteContent = clone.textContent?.trim();

				if (!footnoteContent) continue;

				allItems.push({
					el: sup,
					rect: sup.getBoundingClientRect(),
					type: "footnote",
					text: footnoteContent,
					footnoteId: fnId,
				});
			}
		}

		if (allItems.length === 0) return;

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

				margin.appendChild(
					this.renderLinksToFragment(this.normalizeText(item.text)),
				);
			}

			item.el.parentNode?.insertBefore(wrapper, item.el);
			wrapper.appendChild(item.el);
			wrapper.appendChild(margin);

			this.observeSidenoteVisibility(margin);
			marginNotes.push(margin);
		}

		// Run collision avoidance after DOM is fully settled
		// Use setTimeout to ensure layout is complete
		setTimeout(() => {
			this.avoidCollisionsInReadingMode(readingRoot);
		}, 50);
	}
	/**
	 * Remove all sidenote markup from reading mode to allow fresh processing.
	 */
	private removeAllSidenoteMarkupFromReadingMode(root: HTMLElement) {
		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
			// Find the original content inside (sidenote span or footnote sup)
			const sidenoteSpan =
				wrapper.querySelector<HTMLElement>("span.sidenote");
			const footnoteSup =
				wrapper.querySelector<HTMLElement>("sup.footnote-ref");
			const originalEl = sidenoteSpan ?? footnoteSup;

			// If it's a footnote, restore the anchor visibility
			if (footnoteSup) {
				const anchor = footnoteSup.querySelector("a.footnote-link");
				if (anchor) {
					(anchor as HTMLElement).style.display = "";
				}
			}

			// Remove the margin element
			const margin = wrapper.querySelector<HTMLElement>(
				"small.sidenote-margin",
			);
			if (margin) {
				this.unobserveSidenoteVisibility(margin);
				margin.remove();
			}

			// Unwrap: move the original element back to where the wrapper was
			if (originalEl && wrapper.parentNode) {
				wrapper.parentNode.insertBefore(originalEl, wrapper);
			}

			// Remove the now-empty wrapper
			wrapper.remove();
		}
	}

	/**
	 * Parse a formatted number back to its numeric value.
	 * Handles arabic, roman, and letter formats.
	 */
	private parseFormattedNumber(str: string): number {
		// Try arabic first
		const arabic = parseInt(str, 10);
		if (!isNaN(arabic)) {
			return arabic;
		}

		// Try roman numerals
		const roman = this.fromRoman(str.toLowerCase());
		if (roman > 0) {
			return roman;
		}

		// Try letters
		const letter = this.fromLetters(str.toLowerCase());
		if (letter > 0) {
			return letter;
		}

		return 0;
	}

	/**
	 * Convert roman numeral string to number.
	 */
	private fromRoman(str: string): number {
		const romanValues: Record<string, number> = {
			i: 1,
			v: 5,
			x: 10,
			l: 50,
			c: 100,
			d: 500,
			m: 1000,
		};

		let result = 0;
		let prevValue = 0;

		for (let i = str.length - 1; i >= 0; i--) {
			const char: string | undefined = str[i];
			if (!char) {
				continue;
			}

			const value: number = romanValues[char as string] ?? 0;

			if (value === 0) {
				return 0; // Invalid character
			}

			if (value < prevValue) {
				result -= value;
			} else {
				result += value;
			}
			prevValue = value;
		}

		return result;
	}

	/**
	 * Convert letter string to number (a=1, b=2, ..., z=26, aa=27, etc.)
	 */
	private fromLetters(str: string): number {
		let result = 0;

		for (const char of str) {
			const code = char.charCodeAt(0);
			if (code < 97 || code > 122) {
				return 0; // Invalid character
			}
			result = result * 26 + (code - 96);
		}

		return result;
	}

	/**
	 * Find the content of a footnote by its ID in reading mode.
	 */
	private findFootnoteContent(
		root: HTMLElement,
		fnId: string,
	): string | null {
		// Obsidian renders footnote definitions in a section like:
		// <section class="footnotes" data-footnotes>
		//   <ol>
		//     <li id="fn-1-HASH">
		//       <p>Footnote text <a href="#fnref-1-HASH" class="footnote-backref">↩</a></p>
		//     </li>
		//   </ol>
		// </section>

		// Method 1: Direct ID lookup
		let li: Element | null = null;

		try {
			// Try with CSS.escape for IDs with special characters
			li = root.querySelector(`#${CSS.escape(fnId)}`);
		} catch (e) {
			// Fallback without escape
			try {
				li = root.querySelector(`[id="${fnId}"]`);
			} catch (e2) {
				// Continue to other methods
			}
		}

		if (li) {
			return this.extractFootnoteText(li as HTMLElement);
		}

		// Method 2: Look in footnotes section by scanning all li elements
		const footnoteSections = root.querySelectorAll(
			"section.footnotes, section[data-footnotes], .footnotes",
		);

		for (const section of Array.from(footnoteSections)) {
			const items = section.querySelectorAll("li");
			for (const item of Array.from(items)) {
				if (item.id === fnId) {
					return this.extractFootnoteText(item);
				}
			}
		}

		// Method 3: Look for any li with matching id pattern
		const allLis = root.querySelectorAll("li[id^='fn-']");
		for (const item of Array.from(allLis)) {
			if (item.id === fnId) {
				return this.extractFootnoteText(item as HTMLElement);
			}
		}

		return null;
	}

	/**
	 * Extract text content from a footnote li element, removing backref links.
	 */
	private extractFootnoteText(li: HTMLElement): string | null {
		const clone = li.cloneNode(true) as HTMLElement;

		// Remove all backref links
		clone
			.querySelectorAll(
				"a.footnote-backref, a[class*='backref'], a[href^='#fnref']",
			)
			.forEach((el) => el.remove());

		const text = clone.textContent?.trim();
		return text || null;
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

			const scaleFactor = this.calculateScaleFactor(width);
			readingRoot.style.setProperty(
				"--sidenote-scale",
				scaleFactor.toFixed(3),
			);

			// Run collision avoidance for reading mode
			this.avoidCollisionsInReadingMode(readingRoot);
		});
	}

	/**
	 * Run collision avoidance specifically for reading mode sidenotes.
	 */
	private avoidCollisionsInReadingMode(readingRoot: HTMLElement) {
		const margins = Array.from(
			readingRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);

		if (margins.length === 0) return;

		// Reset all shifts first
		for (const margin of margins) {
			margin.style.setProperty("--sidenote-shift", "0px");
		}

		// Force reflow to get accurate measurements
		void readingRoot.offsetHeight;

		// Measure positions after reset
		const measured = margins
			.map((el) => {
				const rect = el.getBoundingClientRect();
				// Get the wrapper's position as the "anchor" point
				const wrapper = el.closest(".sidenote-number");
				const wrapperRect = wrapper?.getBoundingClientRect();
				return {
					el,
					rect,
					anchorTop: wrapperRect?.top ?? rect.top,
				};
			})
			.filter((item) => item.rect.height > 0)
			.sort((a, b) => a.anchorTop - b.anchorTop);

		if (measured.length === 0) return;

		const spacing = this.settings.collisionSpacing;
		let previousBottom = -Infinity;

		for (const { el, rect, anchorTop } of measured) {
			// The margin wants to be at anchorTop (aligned with its reference)
			// But it can't overlap with the previous margin
			const minTop =
				previousBottom === -Infinity
					? anchorTop
					: previousBottom + spacing;

			const actualTop = Math.max(anchorTop, minTop);
			const shift = actualTop - anchorTop;

			if (shift > 0.5) {
				el.style.setProperty("--sidenote-shift", `${shift}px`);
			}

			// Update previousBottom based on where this margin actually ends up
			previousBottom = actualTop + rect.height;
		}
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

		// Check for explicit sidenotes
		const hasExplicitSidenotes = SIDENOTE_PATTERN.test(content);
		SIDENOTE_PATTERN.lastIndex = 0;

		// For editing mode, only count sidenotes (not footnotes)
		// Footnotes are only converted in reading mode
		this.documentHasSidenotes = hasExplicitSidenotes;

		// Count total sidenotes in document for validation
		if (this.needsFullRenumber) {
			this.totalSidenotesInDocument = this.countSidenotesInSource(content);
		}

		if (this.cmRoot) {
			this.cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";
		}

		const readingRoot = view.containerEl.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			// In reading mode, also count footnotes if conversion is enabled
			let hasContent = hasExplicitSidenotes;
			if (this.settings.convertFootnotes !== "off") {
				hasContent = hasContent || /\[\^[^\]]+\](?!:)/.test(content);
			}
			readingRoot.dataset.hasSidenotes = hasContent ? "true" : "false";
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

				currentId = defMatch[1] ?? null;
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

	/**
	 * Build a combined map of all sidenotes AND footnotes in the source document.
	 * Returns an array of { index, charPos, text, type, footnoteId } for each.
	 */
	private buildSidenoteIndexMap(content: string): {
		index: number;
		charPos: number;
		text: string;
		type: "sidenote" | "footnote";
		footnoteId?: string;
	}[] {
		const items: {
			index: number;
			charPos: number;
			text: string;
			type: "sidenote" | "footnote";
			footnoteId?: string;
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
				type: "sidenote",
			});
		}

		// Find all footnote references if conversion is enabled for editing
		if (this.settings.convertFootnotes === "both") {
			const footnoteDefinitions = this.parseFootnoteDefinitions(content);
			const footnoteRefRegex = /\[\^([^\]]+)\](?!:)/g;

			while ((match = footnoteRefRegex.exec(content)) !== null) {
				const id = match[1];
				if (!id) continue;
				const text =
					footnoteDefinitions.get(id) ?? `[Footnote ${id} not found]`;

				items.push({
					index: 0,
					charPos: match.index,
					text: this.normalizeText(text),
					type: "footnote",
					footnoteId: id,
				});
			}
		}

		// Sort by position and assign indices
		items.sort((a, b) => a.charPos - b.charPos);
		items.forEach((item, i) => {
			item.index = i + 1;
		});

		return items;
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

		let resizeTimeout: number | null = null;
		this.resizeObserver = new ResizeObserver(() => {
			if (resizeTimeout !== null) return;
			resizeTimeout = window.setTimeout(() => {
				resizeTimeout = null;
				this.scheduleLayout();
			}, 100);
		});
		this.resizeObserver.observe(cmRoot);

		const readingRoot = root.querySelector<HTMLElement>(
			".markdown-reading-view",
		);
		if (readingRoot) {
			this.resizeObserver.observe(readingRoot);
			readingRoot.dataset.sidenotePosition =
				this.settings.sidenotePosition;
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
			}, 50);
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		this.cleanups.push(() =>
			scroller.removeEventListener("scroll", onScroll),
		);

		const content = cmRoot.querySelector<HTMLElement>(".cm-content");
		if (content) {
			const mo = new MutationObserver(() => {
				if (this.isMutating) return;
				this.scheduleLayoutDebounced(100);
			});
			mo.observe(content, {
				childList: true,
				subtree: true,
				characterData: true,
			});
			this.cleanups.push(() => mo.disconnect());
		}
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

	/**
	 * Assign numbers to sidenotes based purely on document order.
	 * This is the simplest and most reliable approach - just number them 1, 2, 3...
	 * in the order they appear (sorted by position).
	 */
	private assignSidenoteNumbers(
		spans: {
			el: HTMLElement;
			docPos: number | null;
		}[],
	): Map<HTMLElement, number> {
		const assignments = new Map<HTMLElement, number>();

		if (spans.length === 0) {
			return assignments;
		}

		// Sort by document position
		const sorted = [...spans].sort((a, b) => {
			if (a.docPos === null && b.docPos === null) return 0;
			if (a.docPos === null) return 1;
			if (b.docPos === null) return -1;
			return a.docPos - b.docPos;
		});

		// Simply assign sequential numbers based on sorted order
		// This is the most reliable approach - we don't try to match positions,
		// we just number them in the order they appear in the document
		let num = 1;
		for (const { el } of sorted) {
			assignments.set(el, num);
			num++;
		}

		// Update nextSidenoteNumber for any future additions
		this.nextSidenoteNumber = num;

		// Mark that we've done a full renumber
		this.needsFullRenumber = false;

		return assignments;
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
		cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
			? "true"
			: "false";
		cmRoot.dataset.sidenotePosition = this.settings.sidenotePosition;

		const scaleFactor = this.calculateScaleFactor(editorWidth);
		cmRoot.style.setProperty("--sidenote-scale", scaleFactor.toFixed(3));

		// Get unwrapped sidenote spans (not yet processed)
		const unwrappedSpans = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) => !span.parentElement?.classList.contains("sidenote-number"),
		);

		// NOTE: Footnote conversion in editing mode is disabled for now
		// It causes infinite loops due to DOM mutation issues
		// Only sidenotes work in editing mode; footnotes work in reading mode
		const unwrappedFootnotes: {
			el: HTMLElement;
			id: string;
			text: string;
		}[] = [];

		// If there are new sidenotes to process, we need to renumber everything
		if (unwrappedSpans.length > 0 && mode !== "hidden") {
			// Remove all existing sidenote wrappers and margins to renumber from scratch
			this.removeAllSidenoteMarkup(cmRoot);

			// Get the source content to determine correct indices
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view?.editor) return;

			const content = view.editor.getValue();

			// Build a map of sidenote text content + position to their index
			// Note: Only sidenotes, not footnotes, for editing mode
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

					this.observeSidenoteVisibility(margin);
				}
			} finally {
				this.isMutating = false;
			}

			this.lastSidenoteCount =
				cmRoot.querySelectorAll(".sidenote-margin").length;

			// Run collision avoidance after DOM is settled
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					this.updateVisibleCollisions();
				});
			});
		} else {
			// No new sidenotes, just update collisions for existing ones
			this.lastSidenoteCount =
				cmRoot.querySelectorAll(".sidenote-margin").length;
			if (this.lastSidenoteCount > 0 && mode !== "hidden") {
				requestAnimationFrame(() => {
					this.updateVisibleCollisions();
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
	 * Find the index of an item (sidenote or footnote) in the document.
	 */
	private findItemIndex(
		itemMap: {
			index: number;
			charPos: number;
			text: string;
			type: "sidenote" | "footnote";
			footnoteId?: string;
		}[],
		item: {
			text: string;
			docPos: number | null;
			type: "sidenote" | "footnote";
			footnoteId?: string;
		},
	): number {
		// For footnotes, match by ID
		if (item.type === "footnote" && item.footnoteId) {
			const match = itemMap.find(
				(m) => m.type === "footnote" && m.footnoteId === item.footnoteId,
			);
			if (match) {
				return match.index;
			}
		}

		// For sidenotes, use text and position matching
		const normalizedText = this.normalizeText(item.text);

		// Find all items with matching text and type
		const matchingByText = itemMap.filter(
			(m) => m.type === item.type && m.text === normalizedText,
		);

		if (matchingByText.length === 1) {
			const match = matchingByText[0];
			if (match) {
				return match.index;
			}
		}

		if (matchingByText.length > 1 && item.docPos !== null) {
			// Multiple matches - find the closest by position
			const approxCharPos = Math.floor(item.docPos / 10000);
			let closest: (typeof itemMap)[0] | null = null;
			let closestDist = Infinity;

			for (const m of matchingByText) {
				const dist = Math.abs(m.charPos - approxCharPos);
				if (dist < closestDist) {
					closest = m;
					closestDist = dist;
				}
			}

			if (closest) {
				return closest.index;
			}
		}

		// Fallback: find any item close to this position
		if (item.docPos !== null && itemMap.length > 0) {
			const approxCharPos = Math.floor(item.docPos / 10000);
			let closest: (typeof itemMap)[0] | null = null;
			let closestDist = Infinity;

			for (const m of itemMap) {
				const dist = Math.abs(m.charPos - approxCharPos);
				if (dist < closestDist) {
					closest = m;
					closestDist = dist;
				}
			}

			if (closest) {
				return closest.index;
			}
		}

		return 1;
	}

	/**
	 * Get unprocessed footnote reference elements from the editor.
	 */
	private getUnprocessedFootnoteRefs(
		root: HTMLElement,
	): { el: HTMLElement; id: string; text: string }[] {
		const refs: { el: HTMLElement; id: string; text: string }[] = [];
		const seenIds = new Set<string>();

		// Get footnote definitions from source
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		let footnoteDefinitions = new Map<string, string>();
		if (view?.editor) {
			footnoteDefinitions = this.parseFootnoteDefinitions(
				view.editor.getValue(),
			);
		}

		// In editing mode, footnote references are rendered as:
		// <span class="cm-footref cm-formatting...">[^</span>
		// <span class="cm-footref cm-hmd-barelink">6</span>
		// <span class="cm-footref cm-formatting...">]</span>
		//
		// We need to find the middle span that contains the ID

		const lines = root.querySelectorAll<HTMLElement>(".cm-line");

		for (const line of Array.from(lines)) {
			// Skip footnote definition lines
			if (line.classList.contains("HyperMD-footnote")) continue;

			// Skip if already has a sidenote wrapper
			if (line.querySelector(".sidenote-number")) continue;

			// Find all footref spans in this line
			const footrefSpans = Array.from(
				line.querySelectorAll<HTMLElement>("span.cm-footref"),
			);

			for (let i = 0; i < footrefSpans.length; i++) {
				const span = footrefSpans[i];
				if (!span) continue;

				// Skip if this span is already inside a sidenote-number wrapper
				if (span.closest(".sidenote-number")) continue;

				// Skip if already marked as processed
				if (span.dataset.sidenoteProcessed === "true") continue;

				// Look for the pattern: [^ + id + ]
				// The middle span (with the ID) has cm-hmd-barelink but not cm-formatting
				if (
					span.classList.contains("cm-hmd-barelink") &&
					!span.classList.contains("cm-formatting")
				) {
					const id = span.textContent?.trim() ?? "";

					if (id && !seenIds.has(id)) {
						seenIds.add(id);

						const text =
							footnoteDefinitions.get(id) ?? `[Footnote ${id} not found]`;

						refs.push({
							el: span,
							id,
							text,
						});
					}
				}
			}
		}

		return refs;
	}

	/**
	 * Get all the spans that make up a footnote reference in editing mode.
	 * This includes the [^, the id, and the ] spans.
	 */
	private getFootnoteRefSpans(idSpan: HTMLElement): HTMLElement[] {
		const spans: HTMLElement[] = [];
		const parent = idSpan.parentElement;
		if (!parent) return [idSpan];

		// Get all siblings
		const allSpans = Array.from(
			parent.querySelectorAll<HTMLElement>("span.cm-footref"),
		);
		const idIndex = allSpans.indexOf(idSpan);

		if (idIndex === -1) return [idSpan];

		// The pattern is: [^ (formatting) + id (barelink) + ] (formatting)
		// Look for the opening bracket before the ID span
		if (idIndex > 0) {
			const prevSpan = allSpans[idIndex - 1];
			if (prevSpan && prevSpan.textContent?.includes("[^")) {
				spans.push(prevSpan);
			}
		}

		// Add the ID span itself
		spans.push(idSpan);

		// Look for the closing bracket after the ID span
		if (idIndex < allSpans.length - 1) {
			const nextSpan = allSpans[idIndex + 1];
			if (nextSpan && nextSpan.textContent?.includes("]")) {
				spans.push(nextSpan);
			}
		}

		return spans.length > 0 ? spans : [idSpan];
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
		// Find all sidenote-number wrappers
		const wrappers = root.querySelectorAll<HTMLElement>(
			"span.sidenote-number",
		);

		for (const wrapper of Array.from(wrappers)) {
			// Find the original sidenote span inside
			const sidenoteSpan =
				wrapper.querySelector<HTMLElement>("span.sidenote");

			// Remove the margin element
			const margin = wrapper.querySelector<HTMLElement>(
				"small.sidenote-margin",
			);
			if (margin) {
				this.unobserveSidenoteVisibility(margin);
				margin.remove();
			}

			// Unwrap: move the sidenote span back to where the wrapper was
			if (sidenoteSpan && wrapper.parentNode) {
				wrapper.parentNode.insertBefore(sidenoteSpan, wrapper);
			}

			// Remove the now-empty wrapper
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
		sidenoteIndex: number, // Add this parameter - the 1-based index of this sidenote in the document
	) {
		// Store the sidenote index for reliable identification
		margin.dataset.editing = "false";
		margin.dataset.sidenoteIndex = String(sidenoteIndex);

		// Prevent click from propagating to editor (which would focus the source)
		margin.addEventListener("mousedown", (e) => {
			e.stopPropagation();
		});

		margin.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();

			if (margin.dataset.editing === "true") return;

			this.startMarginEdit(margin, sourceSpan, sidenoteIndex);
		});
	}

	/**
	 * Start editing a margin sidenote in place.
	 */
	private startMarginEdit(
		margin: HTMLElement,
		sourceSpan: HTMLElement,
		sidenoteIndex: number,
	) {
		margin.dataset.editing = "true";

		// Get the raw text content (without the number prefix)
		const currentText = sourceSpan.textContent ?? "";

		// Clear margin and make it a simple text editor
		margin.innerHTML = "";
		margin.contentEditable = "true";
		margin.textContent = currentText;
		margin.focus();

		// Select all text
		const selection = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(margin);
		selection?.removeAllRanges();
		selection?.addRange(range);

		// Handle blur (save changes)
		const onBlur = () => {
			this.finishMarginEdit(margin, sourceSpan, sidenoteIndex);
			margin.removeEventListener("blur", onBlur);
			margin.removeEventListener("keydown", onKeydown);
		};

		// Handle keyboard
		const onKeydown = (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				margin.blur();
			} else if (e.key === "Escape") {
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
			}
		};

		margin.addEventListener("blur", onBlur);
		margin.addEventListener("keydown", onKeydown);
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
		if (!view) return;

		const editor = view.editor;
		if (!editor) return;

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
				editor.replaceRange(newSpan, from, to);
				this.isMutating = false;

				found = true;
				break;
			}
		}

		// Restore scroll position after edit
		if (found) {
			// Use multiple RAFs to ensure we restore after all updates
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					if (scroller) {
						scroller.scrollTop = scrollTop;
					}
					this.isEditingMargin = false;
				});
			});
		} else {
			this.isEditingMargin = false;
			// Couldn't find the sidenote to update, just restore the margin display
			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(newText)),
			);
		}
	}

	// ==================== Footnote Margin Editing ====================

	/**
	 * Set up a footnote margin element to be editable in place.
	 */
	private setupFootnoteMarginEditing(
		margin: HTMLElement,
		footnoteId: string,
		originalText: string,
		footnoteIndex: number,
	) {
		margin.dataset.editing = "false";
		margin.dataset.footnoteIndex = String(footnoteIndex);

		// Prevent click from propagating to editor
		margin.addEventListener("mousedown", (e) => {
			e.stopPropagation();
		});

		margin.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();

			if (margin.dataset.editing === "true") return;

			this.startFootnoteMarginEdit(margin, footnoteId, originalText);
		});
	}

	/**
	 * Start editing a footnote margin in place.
	 */
	private startFootnoteMarginEdit(
		margin: HTMLElement,
		footnoteId: string,
		originalText: string,
	) {
		margin.dataset.editing = "true";

		// Clear margin and make it editable
		margin.innerHTML = "";
		margin.contentEditable = "true";
		margin.textContent = originalText;
		margin.focus();

		// Select all text
		const selection = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(margin);
		selection?.removeAllRanges();
		selection?.addRange(range);

		const onBlur = () => {
			this.finishFootnoteMarginEdit(margin, footnoteId, originalText);
			margin.removeEventListener("blur", onBlur);
			margin.removeEventListener("keydown", onKeydown);
		};

		const onKeydown = (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				margin.blur();
			} else if (e.key === "Escape") {
				e.preventDefault();
				margin.dataset.editing = "false";
				margin.contentEditable = "false";
				margin.innerHTML = "";
				margin.appendChild(
					this.renderLinksToFragment(this.normalizeText(originalText)),
				);
				margin.removeEventListener("blur", onBlur);
				margin.removeEventListener("keydown", onKeydown);
			}
		};

		margin.addEventListener("blur", onBlur);
		margin.addEventListener("keydown", onKeydown);
	}

	/**
	 * Finish editing a footnote and save changes to the source document.
	 */
	private finishFootnoteMarginEdit(
		margin: HTMLElement,
		footnoteId: string,
		originalText: string,
	) {
		const newText = margin.textContent ?? "";

		margin.dataset.editing = "false";
		margin.contentEditable = "false";

		// If no change, just restore the rendered content
		if (newText === originalText) {
			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(newText)),
			);
			return;
		}

		// Update the source document
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const editor = view.editor;
		if (!editor) return;

		// Save scroll position
		const scroller =
			this.cmRoot?.querySelector<HTMLElement>(".cm-scroller");
		const scrollTop = scroller?.scrollTop ?? 0;

		this.isEditingMargin = true;

		const content = editor.getValue();

		// Find and replace the footnote definition
		// Match: [^id]: text (possibly multiline)
		const escapedId = footnoteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const footnoteDefRegex = new RegExp(
			`^(\\[\\^${escapedId}\\]:\\s*)(.+(?:\\n(?:[ \\t]+.+)*)?)$`,
			"gm",
		);

		const match = footnoteDefRegex.exec(content);
		if (match) {
			const prefix = match[1] ?? "";
			const from = editor.offsetToPos(match.index + prefix.length);
			const to = editor.offsetToPos(match.index + match[0].length);

			this.isMutating = true;
			editor.replaceRange(newText, from, to);
			this.isMutating = false;

			// Restore scroll position
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					if (scroller) {
						scroller.scrollTop = scrollTop;
					}
					this.isEditingMargin = false;
				});
			});
		} else {
			this.isEditingMargin = false;
			// Couldn't find the footnote to update, just restore the margin display
			margin.innerHTML = "";
			margin.appendChild(
				this.renderLinksToFragment(this.normalizeText(newText)),
			);
		}
	}

	// ==================== Collision Avoidance ====================

	/**
	 * Run collision avoidance on all sidenotes, not just visible ones.
	 * This is more robust for ensuring proper spacing.
	 */
	private avoidCollisions(nodes: HTMLElement[], spacing: number) {
		if (nodes.length === 0) return;

		// Always recalculate - remove the hash check for more robustness
		// Reset all shifts first
		for (const sn of nodes) {
			sn.style.setProperty("--sidenote-shift", "0px");
		}

		// Force a reflow to get accurate measurements after reset
		void nodes[0]?.offsetHeight;

		// Measure and sort
		const measured = nodes
			.map((el) => ({
				el,
				rect: el.getBoundingClientRect(),
			}))
			.filter((item) => item.rect.height > 0) // Filter out hidden/zero-height elements
			.sort((a, b) => a.rect.top - b.rect.top);

		if (measured.length === 0) return;

		const updates: {
			el: HTMLElement;
			shift: number;
		}[] = [];
		let bottom = -Infinity;

		for (const { el, rect } of measured) {
			const desiredTop = rect.top;
			const minTop = bottom === -Infinity ? desiredTop : bottom + spacing;
			const actualTop = Math.max(desiredTop, minTop);

			const shift = actualTop - desiredTop;
			if (shift > 0.5) {
				updates.push({ el, shift });
			}

			bottom = actualTop + rect.height;
		}

		// Apply all updates
		for (const { el, shift } of updates) {
			el.style.setProperty("--sidenote-shift", `${shift}px`);
		}

		// Update hash after successful collision avoidance
		this.lastCollisionHash = measured
			.map((m) => `${Math.round(m.rect.top)}:${Math.round(m.rect.height)}`)
			.join("|");
	}

	/**
	 * Update collisions for all margin notes in the current view.
	 */
	private updateVisibleCollisions() {
		// Handle source view
		if (this.cmRoot) {
			const sourceMargins = Array.from(
				this.cmRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
			);
			if (sourceMargins.length > 0) {
				this.avoidCollisions(
					sourceMargins,
					this.settings.collisionSpacing,
				);
			}
		}

		// Handle reading view separately
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			const readingRoot = view.containerEl.querySelector<HTMLElement>(
				".markdown-reading-view",
			);
			if (readingRoot) {
				this.avoidCollisionsInReadingMode(readingRoot);
			}
		}
	}
}

// ==================== Settings Tab ====================

// ==================== Settings Tab ====================

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
			.setName("Convert footnotes to sidenotes")
			.setDesc(
				"Display standard Obsidian footnotes as sidenotes in the margin",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("off", "Off")
					.addOption("reading", "Reading mode only")
					// .addOption("both", "Reading and editing modes")
					.setValue(this.plugin.settings.convertFootnotes)
					.onChange(async (value: "off" | "reading" | "both") => {
						this.plugin.settings.convertFootnotes = value;
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h2", { text: "Width & Spacing" });

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
			.setName("Gap between sidenote and text")
			.setDesc(
				"Space between the margin and body text in rem (default: 2)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 5, 0.5)
					.setValue(this.plugin.settings.sidenoteGap)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.sidenoteGap = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Page Offset Factor")
			.setDesc(
				"Adjusts how much body text gets nudged over - only affects notes with sidenotes (default: 0.5)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.1, 1, 0.1)
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

// ==================== CodeMirror 6 Footnote Sidenote Widget ====================

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

		// Render the content with markdown formatting support
		const fragment = this.plugin.renderLinksToFragmentPublic(
			this.plugin.normalizeTextPublic(this.content),
		);
		margin.appendChild(fragment);

		wrapper.appendChild(margin);

		return wrapper;
	}

	eq(other: FootnoteSidenoteWidget): boolean {
		return (
			this.content === other.content &&
			this.numberText === other.numberText &&
			this.footnoteId === other.footnoteId
		);
	}

	ignoreEvent(): boolean {
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
		if (
			update.docChanged ||
			update.viewportChanged ||
			update.geometryChanged
		) {
			this.decorations = this.buildDecorations(update.state);
		}
	}

	buildDecorations(state: EditorState): DecorationSet {
		if (this.plugin.settings.convertFootnotes !== "both") {
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

		// Also collect sidenotes for combined numbering
		const sidenoteRegex =
			/<span\s+class\s*=\s*["']sidenote["'][^>]*>[\s\S]*?<\/span>/gi;
		const allItems: {
			type: "sidenote" | "footnote";
			pos: number;
			id?: string;
		}[] = [];

		let sidenoteMatch: RegExpExecArray | null;
		while ((sidenoteMatch = sidenoteRegex.exec(content)) !== null) {
			allItems.push({ type: "sidenote", pos: sidenoteMatch.index });
		}

		while ((match = referenceRegex.exec(content)) !== null) {
			const id = match[1];
			if (id && footnoteDefinitions.has(id)) {
				allItems.push({ type: "footnote", pos: match.index, id });
			}
		}

		// Sort by position
		allItems.sort((a, b) => a.pos - b.pos);

		// Assign numbers
		const itemNumbers = new Map<number, number>();
		let num = 1;
		for (const item of allItems) {
			itemNumbers.set(item.pos, num++);
		}

		// Reset regex again for final pass
		referenceRegex.lastIndex = 0;

		// Second pass: create decorations
		while ((match = referenceRegex.exec(content)) !== null) {
			const from = match.index;
			const to = from + match[0].length;
			const id = match[1];

			if (!id) continue;

			const footnoteContent = footnoteDefinitions.get(id);
			if (!footnoteContent) continue;

			const itemNum = itemNumbers.get(from) ?? 1;
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
