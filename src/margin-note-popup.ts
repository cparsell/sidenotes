/**
 * Margin notes displayed as a click-to-open popup instead of an inline margin.
 *
 * The popup is appended to `document.body` — it has to escape the note's
 * scroll container — which is why this returns a teardown rather than relying
 * on the wrapper being removed. Dropping that teardown leaks a
 * document-level click listener and leaves the popup behind.
 */

import type { App, PluginManifest } from "obsidian";
import type { SidenoteSettings } from "./settings";
import { normalizeText, renderLinksToFragment } from "./content";
import {
	type InlineEditorHandle,
	openInlineMarkdownEditor,
} from "./inline-editor";

export interface MarginNotePopupContext {
	readonly app: App;
	readonly manifest: PluginManifest;
	readonly settings: SidenoteSettings;

	/** Write the edited text back to the note's source. */
	commitFootnoteSidenoteText(footnoteId: string, newText: string): void;
	commitHtmlSpanSidenoteText(originalText: string, newText: string): void;
}

/**
 * Convert a margin note wrapper to popup mode:
 * hide the margin, show an ⓘ icon inline, and display
 * content in a small popup on click.
 */
export function setupMarginNotePopup(
	ctx: MarginNotePopupContext,
	wrapper: HTMLElement,
	margin: HTMLElement,
	contentText: string,
	editable: boolean = false,
	footnoteId?: string,
): () => void {
	wrapper.classList.add("popup-mode");
	margin.classList.add("popup-mode-margin");

	margin.innerHTML = "";
	const icon = createSpan();
	icon.className = "margin-note-icon";
	icon.setAttribute("aria-label", "Show margin note");

	const iconSetting = ctx.settings.popupIcon || "ⓘ";

	if (
		iconSetting.endsWith(".png") ||
		iconSetting.endsWith(".svg") ||
		iconSetting.endsWith(".jpg")
	) {
		// Image file from plugin assets folder
		const img = createEl("img");
		img.src = ctx.app.vault.adapter.getResourcePath(
			`${ctx.manifest.dir}/assets/${iconSetting}`,
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
				renderLinksToFragment(normalizeText(currentRawText), ctx.app),
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
				app: ctx.app,
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
							ctx.commitFootnoteSidenoteText(footnoteId, text);
						} else {
							ctx.commitHtmlSpanSidenoteText(currentRawText, text);
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

		popup.appendChild(contentEl);
		document.body.appendChild(popup);

		return () => {
			document.removeEventListener("click", onOutsideClick, true);
			popupEditor?.close({ commit: false });
			popup.remove();
		};
	}

	// Read-only path
	contentEl.appendChild(
		renderLinksToFragment(normalizeText(contentText), ctx.app),
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

	return () => {
		document.removeEventListener("click", onOutsideClick, true);
		popup.remove();
	};
}
