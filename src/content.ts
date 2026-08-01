import type { App } from "obsidian";
import type { SidenoteSettings } from "./settings";

// ==================== Number Formatting ====================

export function formatNumber(
	num: number,
	style: SidenoteSettings["numberStyle"],
): string {
	switch (style) {
		case "roman":
			return toRoman(num);
		case "letters":
			return toLetters(num);
		case "arabic":
		default:
			return String(num);
	}
}

function toRoman(num: number): string {
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

function toLetters(num: number): string {
	if (num <= 0) return "a"; // Handle edge case
	let result = "";
	while (num > 0) {
		num--;
		result = String.fromCharCode(97 + (num % 26)) + result;
		num = Math.floor(num / 26);
	}
	return result;
}

// ==================== Text Normalization ====================

export function normalizeText(s: string): string {
	return (s ?? "")
		.replace(/<br\s*\/?>/gi, "\n") // Preserve <br> as newlines
		.replace(/[ \t]+/g, " ") // Collapse spaces/tabs (but not \n)
		.trim();
}

/**
 * Append text to a fragment, converting \n to <br> elements.
 */
function appendTextWithBreaks(
	frag: DocumentFragment | HTMLElement,
	text: string,
) {
	const parts = text.split("\n");
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] ?? "";

		if (part) {
			frag.appendChild(document.createTextNode(part));
		}
		if (i < parts.length - 1) {
			frag.appendChild(createEl("br"));
		}
	}
}

/**
 * Render markdown-formatted text to a DocumentFragment.
 * Supports: **bold**, *italic*, _italic_, `code`, [links](url), and [[wiki links]]
 * @param text The markdown-formatted text to render
 * @param app Obsidian's App instance, used to resolve internal-link clicks
 */
export function renderLinksToFragment(
	text: string,
	app: App,
): DocumentFragment {
	const frag = createFragment();

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
			appendTextWithBreaks(frag, text.slice(last, start));
		}

		if (m[1] !== undefined) {
			// Bold: **text**
			const strong = createEl("strong");
			strong.textContent = m[1];
			frag.appendChild(strong);
		} else if (m[2] !== undefined) {
			// Bold: __text__
			const strong = createEl("strong");
			strong.textContent = m[2];
			frag.appendChild(strong);
		} else if (m[3] !== undefined) {
			// Italic: *text*
			const em = createEl("em");
			em.textContent = m[3];
			frag.appendChild(em);
		} else if (m[4] !== undefined) {
			// Italic: _text_
			const em = createEl("em");
			em.textContent = m[4];
			frag.appendChild(em);
		} else if (m[5] !== undefined) {
			// Code: `text`
			const code = createEl("code");
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

			const a = createEl("a");
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
					void app.workspace.openLinkText(url, "", false);
				});
			}
			frag.appendChild(a);
		} else if (m[8] !== undefined) {
			// Wiki link: [[target]] or [[target|display]]
			const target = m[8].trim();
			const display = m[9]?.trim() || target;

			const a = createEl("a");
			a.textContent = display;
			a.className = "internal-link";
			a.setAttribute("data-href", target);
			a.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				void app.workspace.openLinkText(target, "", false);
			});
			frag.appendChild(a);
		}

		last = start + fullMatch.length;
	}

	// Add remaining text
	if (last < text.length) {
		appendTextWithBreaks(frag, text.slice(last));
	}

	return frag;
}

// ==================== Footnote Parsing ====================

/**
 * Determine whether an element or footnote ID represents a margin note
 * (unnumbered sidenote).
 * - HTML format: <span class="sidenote margin-note">
 * - Footnote format: [^mn-...]
 */
export function isMarginNote(elOrId: HTMLElement | string): boolean {
	if (typeof elOrId === "string") {
		// Footnote ID — margin note if it starts with "mn-"
		return elOrId.startsWith("mn-");
	}
	// HTML element — margin note if it has the "margin-note" class
	return elOrId.classList.contains("margin-note");
}

export function parseFootnoteDefinitions(content: string): Map<string, string> {
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

/**
 * Footnote IDs in the order their references appear in the source, which is
 * the order Obsidian numbers them when rendering.
 */
export function buildSourceRefOrder(content: string): string[] {
	const order: string[] = [];
	if (!content) return order;

	const refOrderRegex = /\[\^([^\]]+)\](?!:)/g;
	let match: RegExpExecArray | null;
	while ((match = refOrderRegex.exec(content)) !== null) {
		const id = match[1];
		if (id && !order.includes(id)) {
			order.push(id);
		}
	}
	return order;
}

/**
 * Strip Obsidian's `fn-`/`fnref-` prefix and its per-render hash suffix
 * (`fnref-1-a1b2c3` → `1`, `fnref-1` → `1`).
 */
export function parseFootnoteIdString(
	raw: string,
	prefix: "fn" | "fnref",
): string | null {
	if (!raw) return null;

	const hashMatch = raw.match(new RegExp(`^${prefix}-(.+?)-[a-f0-9]+$`, "i"));
	if (hashMatch?.[1]) return hashMatch[1];

	const simpleMatch = raw.match(new RegExp(`^${prefix}-(.+)$`, "i"));
	return simpleMatch?.[1] ?? null;
}

/**
 * Resolve the footnote ID a rendered reference points at. Accepts either
 * the `<sup>` or the inner `a.footnote-link`, and falls back to the
 * displayed number when the markup carries no usable ID.
 */
export function resolveFootnoteBaseId(el: HTMLElement): string | null {
	const sup = el.tagName === "SUP" ? el : (el.closest("sup") ?? el);
	const anchor = el.tagName === "A" ? el : sup.querySelector("a");

	const candidates = [
		sup.dataset.footnoteId || "",
		sup.id || "",
		anchor?.id || "",
	];
	for (const raw of candidates) {
		const id = parseFootnoteIdString(raw, "fnref");
		if (id) return id;
	}

	const href = anchor?.getAttribute("href") ?? "";
	if (href.startsWith("#")) {
		const id = parseFootnoteIdString(href.slice(1), "fn");
		if (id) return id;
	}

	// Last resort: the displayed number, e.g. "[1]"
	const numMatch = (sup.textContent ?? "").trim().match(/^\[?(\d+)\]?$/);
	return numMatch?.[1] ?? null;
}
