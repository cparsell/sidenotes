import {
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	App,
} from "obsidian";

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
			if (sidenoteSpans.length > 0) {
				requestAnimationFrame(() => {
					this.processReadingModeSidenotes(element);
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

	// In injectStyles(), update the badge style sections:

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
            --sn-pill-bg: linear-gradient(135deg, var(--interactive-accent) 0%, var(--interactive-accent-hover) 100%);
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
            font-size: 0.7em;
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

		// Collect items to process
		const allItems: {
			el: HTMLElement;
			rect: DOMRect;
			type: "sidenote" | "footnote";
			text: string;
		}[] = [];

		// Get sidenote spans - check in the element AND the full reading root
		// to catch all sidenotes, not just those in the current post-processor element
		const sidenoteContainers = [element];
		if (element !== readingRoot) {
			sidenoteContainers.push(readingRoot);
		}

		const processedSidenotes = new Set<HTMLElement>();

		for (const container of sidenoteContainers) {
			const spans = Array.from(
				container.querySelectorAll<HTMLElement>("span.sidenote"),
			).filter(
				(span) =>
					!span.parentElement?.classList.contains("sidenote-number") &&
					!processedSidenotes.has(span),
			);

			for (const el of spans) {
				processedSidenotes.add(el);
				allItems.push({
					el,
					rect: el.getBoundingClientRect(),
					type: "sidenote",
					text: el.textContent ?? "",
				});
			}
		}

		// Get footnote references if conversion is enabled
		// if (this.settings.convertFootnotes) {
		// 	for (const container of sidenoteContainers) {
		// 		const footnoteRefs = container.querySelectorAll<HTMLElement>(
		// 			"sup.footnote-ref, .footnote-ref, sup:has(a[href^='#fn']), sup:has(a[href^='#^'])",
		// 		);

		// 		for (const el of Array.from(footnoteRefs)) {
		// 			// Skip if already processed
		// 			if (el.closest(".sidenote-number")) continue;

		// 			// Get the footnote ID from the anchor inside
		// 			const anchor =
		// 				el.querySelector("a") ||
		// 				(el.tagName === "A" ? el : null);
		// 			if (!anchor) continue;

		// 			const href = anchor.getAttribute("href") ?? "";
		// 			// Extract ID from various formats: #fn-1, #fn1, #^footnote-id
		// 			const idMatch = href.match(/#(?:fn-?|[\^])(.+)$/);
		// 			const id = idMatch ? idMatch[1] : "";

		// 			if (!id) continue;

		// 			// Find the footnote content
		// 			const footnoteContent = this.findFootnoteContent(
		// 				readingRoot,
		// 				id,
		// 			);

		// 			if (footnoteContent) {
		// 				allItems.push({
		// 					el: el as HTMLElement,
		// 					rect: el.getBoundingClientRect(),
		// 					type: "footnote",
		// 					text: footnoteContent,
		// 				});
		// 			}
		// 		}
		// 	}
		// }

		if (allItems.length === 0) return;

		// Sort by vertical position in document
		allItems.sort((a, b) => a.rect.top - b.rect.top);

		// Start numbering from 1, not from existing count
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

			const margin = document.createElement("small");
			margin.className = "sidenote-margin";
			margin.dataset.sidenoteNum = numStr;

			if (item.type === "sidenote") {
				this.cloneContentToMargin(item.el, margin);
			} else {
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

		// Run collision avoidance after DOM is settled - use longer delay for reading mode
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					this.avoidCollisionsInReadingMode(readingRoot);
				});
			});
		});
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

		// Force reflow
		void margins[0]?.offsetHeight;

		// Measure and sort by position
		const measured = margins
			.map((el) => ({
				el,
				rect: el.getBoundingClientRect(),
			}))
			.filter((item) => item.rect.height > 0)
			.sort((a, b) => a.rect.top - b.rect.top);

		if (measured.length === 0) return;

		const updates: {
			el: HTMLElement;
			shift: number;
		}[] = [];
		let bottom = -Infinity;

		for (const { el, rect } of measured) {
			const desiredTop = rect.top;
			const minTop =
				bottom === -Infinity
					? desiredTop
					: bottom + this.settings.collisionSpacing;
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
		this.documentHasSidenotes = SIDENOTE_PATTERN.test(content);
		SIDENOTE_PATTERN.lastIndex = 0;

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
			readingRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";
		}
	}

	/**
	 * Count the total number of sidenotes in the source document.
	 */
	private countSidenotesInSource(content: string): number {
		const sidenoteRegex = /<span\s+class\s*=\s*["']sidenote["'][^>]*>/gi;
		let count = 0;
		while (sidenoteRegex.exec(content) !== null) {
			count++;
		}
		return count;
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

		// If there are new sidenotes to process, we need to renumber everything
		if (unwrappedSpans.length > 0 && mode !== "hidden") {
			// Remove all existing sidenote wrappers and margins to renumber from scratch
			this.removeAllSidenoteMarkup(cmRoot);

			// Now get ALL sidenote spans (they're all unwrapped now)
			const allSpans = Array.from(
				cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
			);

			if (allSpans.length === 0) {
				this.lastSidenoteCount = 0;
				return;
			}

			// Get the source content to determine correct indices
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view?.editor) return;

			const content = view.editor.getValue();

			// Build a map of sidenote text content + approximate position to their index in the document
			const sidenoteIndices = this.buildSidenoteIndexMap(content);

			const spansWithPos = allSpans.map((el) => ({
				el,
				docPos: this.getDocumentPosition(el),
				text: el.textContent ?? "",
			}));

			// Match each visible span to its index in the full document
			const spansWithIndex = spansWithPos.map(({ el, docPos, text }) => {
				const index = this.findSidenoteIndex(
					sidenoteIndices,
					text,
					docPos,
				);
				return { el, docPos, text, index };
			});

			// Sort by index for consistent ordering
			spansWithIndex.sort((a, b) => a.index - b.index);

			this.isMutating = true;
			try {
				for (const { el: span, index, docPos } of spansWithIndex) {
					const numStr = this.formatNumber(index);

					const wrapper = document.createElement("span");
					wrapper.className = "sidenote-number";
					wrapper.dataset.sidenoteNum = numStr;

					const margin = document.createElement("small");
					margin.className = "sidenote-margin";
					margin.dataset.sidenoteNum = numStr;

					const raw = this.normalizeText(span.textContent ?? "");
					margin.appendChild(this.renderLinksToFragment(raw));

					// Make margin editable and set up edit handling with the correct index
					this.setupMarginEditing(margin, span, docPos, index);

					// Add click handler to select only the text content, not the HTML tags
					this.setupSidenoteClickHandler(wrapper, index);

					span.parentNode?.insertBefore(wrapper, span);
					wrapper.appendChild(span);
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
	 * Build a map of all sidenotes in the source document.
	 * Returns an array of { index, charPos, text } for each sidenote.
	 */
	private buildSidenoteIndexMap(
		content: string,
	): { index: number; charPos: number; text: string }[] {
		const sidenotes: { index: number; charPos: number; text: string }[] =
			[];
		const sidenoteRegex =
			/<span\s+class\s*=\s*["']sidenote["'][^>]*>([\s\S]*?)<\/span>/gi;

		let match: RegExpExecArray | null;
		let index = 1;

		while ((match = sidenoteRegex.exec(content)) !== null) {
			sidenotes.push({
				index,
				charPos: match.index,
				text: this.normalizeText(match[1] ?? ""),
			});
			index++;
		}

		return sidenotes;
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
	 * This unwraps the original span.sidenote elements.
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
