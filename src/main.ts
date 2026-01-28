import { MarkdownView, Plugin, TFile } from "obsidian";

type CleanupFn = () => void;

// Breakpoints for sidenote behavior (in pixels of EDITOR width)
const SIDENOTE_HIDE_BELOW = 700;
const SIDENOTE_COMPACT_BELOW = 900;
const SIDENOTE_FULL_ABOVE = 1400;

// Regex to detect sidenote spans in source text
const SIDENOTE_PATTERN = /<span\s+class\s*=\s*["']sidenote["'][^>]*>/gi;

export default class SidenoteCollisionAvoider extends Plugin {
	private rafId: number | null = null;
	private cleanups: CleanupFn[] = [];
	private cmRoot: HTMLElement | null = null;
	private isMutating = false;
	private resizeObserver: ResizeObserver | null = null;

	// Map from sidenote text content (or position) to assigned number
	private sidenoteRegistry: Map<string, number> = new Map();
	private nextSidenoteNumber = 1;

	// Track whether current document has any sidenotes
	private documentHasSidenotes = false;

	async onload() {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.resetRegistry();
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
				this.scanDocumentForSidenotes();
				this.rebindAndSchedule();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				// Rescan when document content changes
				this.scanDocumentForSidenotes();
				this.scheduleLayout();
			}),
		);
		this.registerDomEvent(window, "resize", () => this.scheduleLayout());

		this.scanDocumentForSidenotes();
		this.rebindAndSchedule();
	}

	onunload() {
		this.cancelScheduled();
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cmRoot = view?.containerEl.querySelector<HTMLElement>(
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
		}
	}

	/**
	 * Scan the current document's source text to determine if it contains any sidenotes.
	 * This is independent of DOM virtualization.
	 */
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

		// Get the full document text
		const content = editor.getValue();

		// Check if any sidenote spans exist
		this.documentHasSidenotes = SIDENOTE_PATTERN.test(content);

		// Reset the regex lastIndex for future tests
		SIDENOTE_PATTERN.lastIndex = 0;

		// Update the data attribute immediately if we have a cmRoot
		if (this.cmRoot) {
			this.cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
				? "true"
				: "false";
		}
	}

	private resetRegistry() {
		this.sidenoteRegistry.clear();
		this.nextSidenoteNumber = 1;
	}

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

	private rebind() {
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];

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

		// Set initial hasSidenotes state
		cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
			? "true"
			: "false";

		this.resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.target === cmRoot) {
					this.scheduleLayout();
				}
			}
		});
		this.resizeObserver.observe(cmRoot);

		const scroller = cmRoot.querySelector<HTMLElement>(".cm-scroller");
		if (!scroller) return;

		const onScroll = () => this.scheduleLayout();
		scroller.addEventListener("scroll", onScroll, { passive: true });
		this.cleanups.push(() =>
			scroller.removeEventListener("scroll", onScroll),
		);

		const content = cmRoot.querySelector<HTMLElement>(".cm-content");
		if (content) {
			const mo = new MutationObserver(() => {
				if (this.isMutating) return;
				this.scheduleLayout();
			});
			mo.observe(content, {
				childList: true,
				subtree: true,
				characterData: true,
			});
			this.cleanups.push(() => mo.disconnect());
		}
	}

	/**
	 * Get the document position of a DOM element by finding its CM line
	 * and querying the editor state for the line's start position.
	 */
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

	/**
	 * Generate a stable key for a sidenote based on its content and position.
	 */
	private getSidenoteKey(el: HTMLElement, docPos: number | null): string {
		const content = this.normalizeText(el.textContent ?? "");
		const posKey = docPos !== null ? docPos.toString() : "unknown";
		return `${posKey}:${content}`;
	}

	/**
	 * Assign numbers to sidenotes based on their document position.
	 */
	private assignSidenoteNumbers(
		spans: { el: HTMLElement; docPos: number | null }[],
	): Map<HTMLElement, number> {
		const assignments = new Map<HTMLElement, number>();

		const sorted = [...spans].sort((a, b) => {
			if (a.docPos === null && b.docPos === null) return 0;
			if (a.docPos === null) return 1;
			if (b.docPos === null) return -1;
			return a.docPos - b.docPos;
		});

		const keysInOrder: {
			el: HTMLElement;
			key: string;
			docPos: number | null;
		}[] = [];
		for (const { el, docPos } of sorted) {
			const key = this.getSidenoteKey(el, docPos);
			keysInOrder.push({ el, key, docPos });
		}

		for (const { el, key, docPos } of keysInOrder) {
			if (this.sidenoteRegistry.has(key)) {
				assignments.set(el, this.sidenoteRegistry.get(key)!);
			} else {
				const num = this.findCorrectNumber(docPos);
				this.sidenoteRegistry.set(key, num);
				assignments.set(el, num);
			}
		}

		return assignments;
	}

	/**
	 * Find the correct number for a sidenote at a given document position.
	 */
	private findCorrectNumber(docPos: number | null): number {
		if (docPos === null) {
			return this.nextSidenoteNumber++;
		}

		const knownPositions: { pos: number; num: number }[] = [];
		for (const [key, num] of this.sidenoteRegistry) {
			const posStr = key.split(":")[0];
			const pos = parseInt(posStr, 10);
			if (!isNaN(pos)) {
				knownPositions.push({ pos, num });
			}
		}

		if (knownPositions.length === 0) {
			return this.nextSidenoteNumber++;
		}

		knownPositions.sort((a, b) => a.pos - b.pos);

		let insertIndex = knownPositions.findIndex((kp) => kp.pos > docPos);
		if (insertIndex === -1) {
			return this.nextSidenoteNumber++;
		}

		const numAtInsert = knownPositions[insertIndex].num;

		let prevNum = 0;
		if (insertIndex > 0) {
			prevNum = knownPositions[insertIndex - 1].num;
		}

		if (prevNum + 1 < numAtInsert) {
			return prevNum + 1;
		}

		return this.nextSidenoteNumber++;
	}

	private layout() {
		const cmRoot = this.cmRoot;
		if (!cmRoot) return;

		const cmRootRect = cmRoot.getBoundingClientRect();
		const editorWidth = cmRootRect.width;

		cmRoot.style.setProperty("--editor-width", `${editorWidth}px`);

		let mode: "hidden" | "compact" | "normal" | "full";
		if (editorWidth < SIDENOTE_HIDE_BELOW) {
			mode = "hidden";
		} else if (editorWidth < SIDENOTE_COMPACT_BELOW) {
			mode = "compact";
		} else if (editorWidth < SIDENOTE_FULL_ABOVE) {
			mode = "normal";
		} else {
			mode = "full";
		}

		cmRoot.dataset.sidenoteMode = mode;
		// Ensure hasSidenotes is always set
		cmRoot.dataset.hasSidenotes = this.documentHasSidenotes
			? "true"
			: "false";

		let scaleFactor = 0;
		if (editorWidth >= SIDENOTE_HIDE_BELOW) {
			scaleFactor = Math.min(
				1,
				(editorWidth - SIDENOTE_HIDE_BELOW) /
					(SIDENOTE_FULL_ABOVE - SIDENOTE_HIDE_BELOW),
			);
		}
		cmRoot.style.setProperty("--sidenote-scale", scaleFactor.toFixed(3));

		const unwrappedSpans = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) =>
				!span.parentElement?.classList.contains("sidenote-number"),
		);

		if (unwrappedSpans.length === 0) {
			const existingMargins = Array.from(
				cmRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
			);
			if (existingMargins.length > 0 && mode !== "hidden") {
				this.avoidCollisions(existingMargins, 8);
			}
			return;
		}

		if (mode === "hidden") {
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
				const numStr = String(num);

				const wrapper = document.createElement("span");
				wrapper.className = "sidenote-number";
				wrapper.dataset.sidenoteNum = numStr;

				const margin = document.createElement("small");
				margin.className = "sidenote-margin";
				margin.dataset.sidenoteNum = numStr;

				const raw = this.normalizeText(span.textContent ?? "");
				margin.appendChild(this.renderMarkdownLinksToFragment(raw));

				span.parentNode?.insertBefore(wrapper, span);
				wrapper.appendChild(span);
				wrapper.appendChild(margin);
			}
		} finally {
			this.isMutating = false;
		}

		const allMargins = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
		);
		if (allMargins.length > 0) {
			this.avoidCollisions(allMargins, 8);
		}
	}

	private normalizeText(s: string): string {
		return (s ?? "").replace(/\s+/g, " ").trim();
	}

	private renderMarkdownLinksToFragment(text: string): DocumentFragment {
		const frag = document.createDocumentFragment();
		const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;

		let last = 0;
		let m: RegExpExecArray | null;

		while ((m = re.exec(text)) !== null) {
			const [full, label, urlRaw] = m;
			const start = m.index;

			if (start > last)
				frag.appendChild(
					document.createTextNode(text.slice(last, start)),
				);

			const url = urlRaw.trim();
			const isSafe =
				url.startsWith("http://") ||
				url.startsWith("https://") ||
				url.startsWith("mailto:");

			if (isSafe) {
				const a = document.createElement("a");
				a.textContent = label;
				a.href = url;
				a.rel = "noopener noreferrer";
				a.target = "_blank";
				frag.appendChild(a);
			} else {
				frag.appendChild(document.createTextNode(full));
			}

			last = start + full.length;
		}

		if (last < text.length)
			frag.appendChild(document.createTextNode(text.slice(last)));

		return frag;
	}

	private avoidCollisions(nodes: HTMLElement[], spacing: number) {
		for (const sn of nodes) sn.style.setProperty("--sidenote-shift", "0px");

		const measured = nodes
			.map((el) => ({ el, rect: el.getBoundingClientRect() }))
			.sort((a, b) => a.rect.top - b.rect.top);

		let bottom = -Infinity;

		for (const { el, rect } of measured) {
			const desiredTop = rect.top;
			const minTop = bottom === -Infinity ? desiredTop : bottom + spacing;
			const actualTop = Math.max(desiredTop, minTop);

			const shift = actualTop - desiredTop;
			if (shift > 0.5)
				el.style.setProperty("--sidenote-shift", `${shift}px`);

			bottom = actualTop + rect.height;
		}
	}
}
