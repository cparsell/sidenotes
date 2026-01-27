import { MarkdownView, Plugin, TFile } from "obsidian";

type CleanupFn = () => void;

// Minimum editor width (in pixels) required to show sidenotes
// Adjust this value to control when sidenotes appear/hide based on editor width
const MIN_EDITOR_WIDTH = 1300;

export default class SidenoteCollisionAvoider extends Plugin {
	private rafId: number | null = null;
	private cleanups: CleanupFn[] = [];
	private cmRoot: HTMLElement | null = null;
	private isMutating = false;

	async onload() {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.rebindAndSchedule(),
			),
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () =>
				this.rebindAndSchedule(),
			),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (_file: TFile | null) =>
				this.rebindAndSchedule(),
			),
		);
		this.registerDomEvent(window, "resize", () => this.scheduleLayout());

		this.rebindAndSchedule();
	}

	onunload() {
		this.cancelScheduled();
		this.cleanups.forEach((fn) => fn());
		this.cleanups = [];
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cmRoot = view?.containerEl.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (cmRoot) {
			// Clean up injected elements and CSS variables
			cmRoot
				.querySelectorAll("span.sidenote-number")
				.forEach((n) => n.remove());
			cmRoot
				.querySelectorAll("small.sidenote-margin")
				.forEach((n) => n.remove());
			cmRoot.style.removeProperty("--editor-width");
		}
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

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const root = view.containerEl;
		const cmRoot = root.querySelector<HTMLElement>(
			".markdown-source-view.mod-cm6",
		);
		if (!cmRoot) return;

		this.cmRoot = cmRoot;

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

	private layout() {
		const cmRoot = this.cmRoot;
		if (!cmRoot) return;

		// Measure editor width and set as CSS variable
		// This updates whenever sidebars open/close
		const cmRootRect = cmRoot.getBoundingClientRect();
		cmRoot.style.setProperty("--editor-width", `${cmRootRect.width}px`);
		console.log(`Set --editor-width to ${cmRootRect.width}px`);

		// Find all sidenote spans that are NOT already wrapped
		const spans = Array.from(
			cmRoot.querySelectorAll<HTMLElement>("span.sidenote"),
		).filter(
			(span) =>
				!span.parentElement?.classList.contains("sidenote-number"),
		);

		if (spans.length === 0) {
			// Even if no new spans, still do collision avoidance on existing ones
			const existingMargins = Array.from(
				cmRoot.querySelectorAll<HTMLElement>("small.sidenote-margin"),
			);
			if (existingMargins.length > 0) {
				this.avoidCollisions(existingMargins, 8);
			}
			return;
		}

		// Check editor container width
		if (cmRootRect.width < MIN_EDITOR_WIDTH) {
			// Editor too narrow, don't show sidenotes
			return;
		}

		// Sort by visual position
		const ordered = spans
			.map((el) => ({ el, rect: el.getBoundingClientRect() }))
			.sort((a, b) => a.rect.top - b.rect.top);

		// Get existing sidenote count to continue numbering
		const existingWrappers = cmRoot.querySelectorAll(".sidenote-number");
		let n = existingWrappers.length + 1;

		const marginNotes: HTMLElement[] = [];

		this.isMutating = true;
		try {
			for (const { el: span } of ordered) {
				const num = String(n++);

				// Create wrapper span with data attribute
				const wrapper = document.createElement("span");
				wrapper.className = "sidenote-number";
				wrapper.dataset.sidenoteNum = num;

				// Create the actual margin note
				const margin = document.createElement("small");
				margin.className = "sidenote-margin";
				margin.dataset.sidenoteNum = num;

				// Render content with Markdown links
				const raw = this.normalizeText(span.textContent ?? "");
				margin.appendChild(this.renderMarkdownLinksToFragment(raw));

				// Wrap the original span
				span.parentNode?.insertBefore(wrapper, span);
				wrapper.appendChild(span);
				wrapper.appendChild(margin);

				marginNotes.push(margin);
			}
		} finally {
			this.isMutating = false;
		}

		// Collision avoidance on ALL margin notes
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
