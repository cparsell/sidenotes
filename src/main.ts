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

	// Width & Spacing
	minSidenoteWidth: number;
	maxSidenoteWidth: number;
	sidenoteGap: number;

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

	// Width & Spacing
	minSidenoteWidth: 10,
	maxSidenoteWidth: 18,
	sidenoteGap: 2,

	// Breakpoints
	hideBelow: 700,
	compactBelow: 900,
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

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new SidenoteSettingTab(this.app, this));
		this.injectStyles();
		this.setupVisibilityObserver();

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
				this.scanDocumentForSidenotes();
				this.needsFullRenumber = true;
				this.invalidateLayoutCache();
				this.lastCollisionHash = ""; // Force collision recalculation
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
				--page-offset: calc((var(--sidenote-width) + var(--sidenote-gap)) * 0.8);
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
			
			.sidenote-number::after {
				content: ${s.showSidenoteNumbers ? "attr(data-sidenote-num)" : "none"};
				vertical-align: super;
				font-size: 0.7em;
				font-weight: bold;
				margin-right: 0.4rem;
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
			
			.sidenote-margin[data-sidenote-num]::before {
				content: ${s.showSidenoteNumbers ? 'attr(data-sidenote-num) ". "' : "none"};
				font-weight: bold;
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

		const unwrappedSpans = Array.from(
			element.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) =>
				!span.parentElement?.classList.contains("sidenote-number"),
		);

		if (unwrappedSpans.length === 0) return;

		const ordered = unwrappedSpans
			.map((el) => ({
				el,
				rect: el.getBoundingClientRect(),
			}))
			.sort((a, b) => a.rect.top - b.rect.top);

		const existingCount =
			readingRoot.querySelectorAll(".sidenote-number").length;
		let num = existingCount + 1;

		const marginNotes: HTMLElement[] = [];

		for (const { el: span } of ordered) {
			if (this.settings.resetNumberingPerHeading) {
				const heading = this.findPrecedingHeading(span);
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

			this.cloneContentToMargin(span, margin);

			span.parentNode?.insertBefore(wrapper, span);
			wrapper.appendChild(span);
			wrapper.appendChild(margin);

			this.observeSidenoteVisibility(margin);
			marginNotes.push(margin);
		}

		// Run collision avoidance with double RAF to ensure DOM is settled
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				this.updateVisibleCollisions();
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
			heading.textContent?.trim() ||
			heading.id ||
			Math.random().toString()
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
				link.getAttribute("data-href") ||
				link.getAttribute("href") ||
				"";

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
		return Math.min(1, (width - s.hideBelow) / (s.fullAbove - s.hideBelow));
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

			this.updateVisibleCollisions();
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
		this.documentHasSidenotes = SIDENOTE_PATTERN.test(content);
		SIDENOTE_PATTERN.lastIndex = 0;

		// Build a complete registry of all sidenotes in the document by their character position
		if (this.needsFullRenumber) {
			this.rebuildRegistryFromSource(content);
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
	 * Rebuild the sidenote registry by scanning the source document.
	 * This ensures consistent numbering regardless of what's currently rendered.
	 */
	private rebuildRegistryFromSource(content: string) {
		this.sidenoteRegistry.clear();

		// Find all sidenote spans in the source and assign numbers by position
		const sidenoteRegex =
			/<span\s+class\s*=\s*["']sidenote["'][^>]*>[\s\S]*?<\/span>/gi;

		let match: RegExpExecArray | null;
		let num = 1;

		while ((match = sidenoteRegex.exec(content)) !== null) {
			const charPos = match.index;
			// Use character position as the key (multiply by 10000 to match getDocumentPosition format)
			const key = `pos-${charPos * 10000}`;
			this.sidenoteRegistry.set(key, num);
			num++;
		}

		this.nextSidenoteNumber = num;
		this.needsFullRenumber = false;
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
	}

	/**
	 * Generate a stable key for a sidenote based on its document position.
	 */
	private getSidenoteKey(docPos: number | null): string {
		if (docPos === null) {
			return `unknown-${Date.now()}-${Math.random()}`;
		}
		return `pos-${docPos}`;
	}

	/**
	 * Find the closest matching registry key for a given document position.
	 * This handles slight position variations due to DOM rendering differences.
	 */
	private findClosestRegistryKey(docPos: number): string | null {
		const exactKey = `pos-${docPos}`;
		if (this.sidenoteRegistry.has(exactKey)) {
			return exactKey;
		}

		// Look for a close match (within a reasonable tolerance)
		// The tolerance accounts for differences between source position and DOM position
		const tolerance = 50000; // Allows for ~5 characters of variance

		let closestKey: string | null = null;
		let closestDistance = Infinity;

		for (const key of this.sidenoteRegistry.keys()) {
			const match = key.match(/^pos-(\d+)$/);
			if (match && match[1]) {
				const keyPos = parseInt(match[1], 10);
				const distance = Math.abs(keyPos - docPos);
				if (distance < tolerance && distance < closestDistance) {
					closestDistance = distance;
					closestKey = key;
				}
			}
		}

		return closestKey;
	}

	/**
	 * Assign numbers to sidenotes based on document order.
	 */
	private assignSidenoteNumbers(
		spans: { el: HTMLElement; docPos: number | null }[],
	): Map<HTMLElement, number> {
		const assignments = new Map<HTMLElement, number>();

		// Sort by document position
		const sorted = [...spans].sort((a, b) => {
			if (a.docPos === null && b.docPos === null) return 0;
			if (a.docPos === null) return 1;
			if (b.docPos === null) return -1;
			return a.docPos - b.docPos;
		});

		for (const { el, docPos } of sorted) {
			if (docPos === null) {
				// Unknown position, use next number
				const num = this.nextSidenoteNumber++;
				assignments.set(el, num);
				continue;
			}

			// Try to find an existing registry entry for this position
			const matchingKey = this.findClosestRegistryKey(docPos);

			if (matchingKey) {
				const num = this.sidenoteRegistry.get(matchingKey)!;
				assignments.set(el, num);
			} else {
				// No match found - this shouldn't happen if rebuildRegistryFromSource worked
				// Fall back to calculating based on position
				const num = this.calculateNumberForPosition(docPos);
				const key = this.getSidenoteKey(docPos);
				this.sidenoteRegistry.set(key, num);
				assignments.set(el, num);
			}
		}

		return assignments;
	}

	/**
	 * Calculate the correct number for a sidenote at a given position
	 * based on existing assignments.
	 */
	private calculateNumberForPosition(docPos: number): number {
		// Get all existing assignments sorted by position
		const existingAssignments: { pos: number; num: number }[] = [];
		for (const [key, num] of this.sidenoteRegistry) {
			const match = key.match(/^pos-(\d+)$/);
			if (match && match[1]) {
				existingAssignments.push({
					pos: parseInt(match[1], 10),
					num,
				});
			}
		}

		if (existingAssignments.length === 0) {
			return this.nextSidenoteNumber++;
		}

		existingAssignments.sort((a, b) => a.pos - b.pos);

		// Find where this position falls
		let insertIndex = existingAssignments.findIndex((a) => a.pos > docPos);

		if (insertIndex === -1) {
			// After all existing
			const lastItem =
				existingAssignments[existingAssignments.length - 1];
			if (lastItem) {
				const newNum = lastItem.num + 1;
				if (newNum >= this.nextSidenoteNumber) {
					this.nextSidenoteNumber = newNum + 1;
				}
				return newNum;
			}
			return this.nextSidenoteNumber++;
		}

		if (insertIndex === 0) {
			// Before all existing
			return 1;
		}

		// Between two existing assignments
		const prevItem = existingAssignments[insertIndex - 1];
		if (prevItem) {
			return prevItem.num + 1;
		}

		return this.nextSidenoteNumber++;
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

		const unwrappedSpans = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) =>
				!span.parentElement?.classList.contains("sidenote-number"),
		);

		if (unwrappedSpans.length === 0) {
			this.lastSidenoteCount =
				cmRoot.querySelectorAll(".sidenote-margin").length;
			if (this.lastSidenoteCount > 0 && mode !== "hidden") {
				// Always run collision avoidance on existing margins
				requestAnimationFrame(() => {
					this.updateVisibleCollisions();
				});
			}
			return;
		}

		if (mode === "hidden") {
			this.lastSidenoteCount =
				cmRoot.querySelectorAll(".sidenote-margin").length;
			return;
		}

		const spansWithPos = unwrappedSpans.map((el) => ({
			el,
			docPos: this.getDocumentPosition(el),
		}));

		const numberAssignments = this.assignSidenoteNumbers(spansWithPos);

		const ordered = spansWithPos
			.map(({ el, docPos }) => ({
				el,
				rect: el.getBoundingClientRect(),
				num: numberAssignments.get(el) ?? 0,
			}))
			.sort((a, b) => a.rect.top - b.rect.top);

		this.isMutating = true;
		try {
			for (const { el: span, num } of ordered) {
				const numStr = this.formatNumber(num);

				const wrapper = document.createElement("span");
				wrapper.className = "sidenote-number";
				wrapper.dataset.sidenoteNum = numStr;

				const margin = document.createElement("small");
				margin.className = "sidenote-margin";
				margin.dataset.sidenoteNum = numStr;

				const raw = this.normalizeText(span.textContent ?? "");
				margin.appendChild(this.renderLinksToFragment(raw));

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

		// Run collision avoidance after a short delay to ensure DOM is settled
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				this.updateVisibleCollisions();
			});
		});
	}

	private normalizeText(s: string): string {
		return (s ?? "").replace(/\s+/g, " ").trim();
	}

	/**
	 * Render both markdown links [text](url) and wiki links [[target]] or [[target|display]]
	 * in source view where we only have raw text.
	 */
	private renderLinksToFragment(text: string): DocumentFragment {
		const frag = document.createDocumentFragment();

		// Combined regex for both link types:
		// - Markdown: [text](url)
		// - Wiki: [[target]] or [[target|display]]
		const combinedRe =
			/\[([^\]]+)\]\(([^)\s]+)\)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

		let last = 0;
		let m: RegExpExecArray | null;

		while ((m = combinedRe.exec(text)) !== null) {
			const start = m.index;
			const fullMatch = m[0];

			// Add text before the match
			if (start > last) {
				frag.appendChild(
					document.createTextNode(text.slice(last, start)),
				);
			}

			if (m[1] !== undefined && m[2] !== undefined) {
				// Markdown link: [text](url)
				const label = m[1];
				const url = m[2].trim();

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
			} else if (m[3] !== undefined) {
				// Wiki link: [[target]] or [[target|display]]
				const target = m[3].trim();
				const display = m[4]?.trim() || target;

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
			.map((el) => ({ el, rect: el.getBoundingClientRect() }))
			.filter((item) => item.rect.height > 0) // Filter out hidden/zero-height elements
			.sort((a, b) => a.rect.top - b.rect.top);

		if (measured.length === 0) return;

		const updates: { el: HTMLElement; shift: number }[] = [];
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
			.map(
				(m) => `${Math.round(m.rect.top)}:${Math.round(m.rect.height)}`,
			)
			.join("|");
	}

	/**
	 * Update collisions for all margin notes in the current view.
	 * More robust than only updating visible ones.
	 */
	private updateVisibleCollisions() {
		// Get all margin notes from both source and reading views
		const allMargins: HTMLElement[] = [];

		if (this.cmRoot) {
			const sourceMargins = this.cmRoot.querySelectorAll<HTMLElement>(
				"small.sidenote-margin",
			);
			allMargins.push(...Array.from(sourceMargins));
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			const readingRoot = view.containerEl.querySelector<HTMLElement>(
				".markdown-reading-view",
			);
			if (readingRoot) {
				const readingMargins =
					readingRoot.querySelectorAll<HTMLElement>(
						"small.sidenote-margin",
					);
				allMargins.push(...Array.from(readingMargins));
			}
		}

		if (allMargins.length > 0) {
			this.avoidCollisions(allMargins, this.settings.collisionSpacing);
		}
	}
}

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
	}
}
