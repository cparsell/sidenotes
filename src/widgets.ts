import { MarkdownView, editorLivePreviewField } from "obsidian";
import {
	EditorView,
	ViewUpdate,
	ViewPlugin,
	Decoration,
	DecorationSet,
	WidgetType,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { setCssProps } from "./dom-utils";
import {
	formatNumber,
	getSidenoteSideOverride,
	isMarginNote,
	normalizeText,
	parseFootnoteDefinitions,
	renderLinksToFragment,
} from "./content";
import type { SidenoteWidgetHost } from "./widget-host";
import {
	type InlineEditorCloseResult,
	type InlineEditorHandle,
	openInlineMarkdownEditor,
} from "./inline-editor";


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
		readonly host: SidenoteWidgetHost,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const isMargin = isMarginNote(this.footnoteId);
		const sideOverride = getSidenoteSideOverride(this.footnoteId);

		const wrapper = createSpan();
		wrapper.className = "sidenote-number";

		wrapper.dataset.sidenoteNum = this.numberText;
		wrapper.dataset.footnoteId = this.footnoteId;

		const margin = createEl("small");
		margin.className = "sidenote-margin";
		if (isMargin) {
			margin.classList.add("margin-note");
			wrapper.classList.add("margin-note");
		}
		if (sideOverride) {
			wrapper.dataset.sidenoteSide = sideOverride;
			margin.dataset.sidenoteSide = sideOverride;
		}

		margin.dataset.sidenoteNum = this.numberText;
		setCssProps(margin, {
			"--sidenote-shift": "0px",
			"--sidenote-line-offset": "0px",
		});

		// Render the content with markdown formatting support
		const fragment = renderLinksToFragment(
			normalizeText(this.content),
			this.host.app,
		);
		margin.appendChild(fragment);

		// Setup popup
		if (isMargin && this.host.settings.marginNoteDisplay === "popup") {
			this.host.setupMarginNotePopup(
				wrapper,
				margin,
				this.content,
				true,
				this.footnoteId,
			);
		}

		// Set up editing for the margin
		this.setupMarginEditing(margin);

		wrapper.appendChild(margin);

		// Add click handler on wrapper (the number badge) to trigger margin editing
		wrapper.addEventListener("click", (e) => {
			// Don't trigger if clicking directly on the margin (it has its own handler)
			if ((e.target as HTMLElement).closest(".sidenote-margin")) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();

			this.startMarginEdit(margin);
		});

		// Prevent mousedown from propagating to CM6 editor
		wrapper.addEventListener("mousedown", (e) => {
			e.stopPropagation();
		});

		// After the widget is attached to the DOM, calculate line offset and trigger collision avoidance
		window.requestAnimationFrame(() => {
			if (wrapper.isConnected) {
				// Calculate line offset within the .cm-line
				const line = wrapper.closest(".cm-line");
				if (line) {
					const wrapperRect = wrapper.getBoundingClientRect();
					const lineRect = line.getBoundingClientRect();
					const lineOffset = wrapperRect.top - lineRect.top;
					margin.style.setProperty(
						"--sidenote-line-offset",
						`${lineOffset}px`,
					);
				}

				this.host.scheduleCollisionUpdate();
			}
		});

		// Track height changes on this margin (inline editor open/close, late
		// image loads) so collisions get re-resolved instead of going stale.
		this.host.observeSidenoteVisibility(margin);

		return wrapper;
	}

	destroy(dom: HTMLElement): void {
		const margin = dom.querySelector<HTMLElement>("small.sidenote-margin");
		if (margin) this.host.unobserveSidenoteVisibility(margin);
	}

	/**
	 * The open margin editor, if any — also the "already editing" guard.
	 * Replaces a view/original-text/outside-listener triple kept in sync by hand.
	 */
	private marginEditor: InlineEditorHandle | null = null;



	/**
	 * Everything that has to happen once the margin editor has closed.
	 * The editor itself handles teardown, listeners and workspace routing.
	 */
	private afterMarginEdit(
		margin: HTMLElement,
		result: InlineEditorCloseResult,
	) {
		this.marginEditor = null;

		// Restore the number attribute
		margin.dataset.sidenoteNum = this.numberText;
		margin.dataset.editing = "false";

		this.host.setActiveFootnoteEdit(null);

		// If committing, write back to the footnote definition in the note.
		if (result.committed && result.renderText !== this.content) {
			this.commitFootnoteText(result.renderText);
		}

		// Re-render with this.content deliberately, NOT the new text: the
		// write-back above changes the document, so CM6 rebuilds this widget
		// with the updated content a moment later. Rendering the new text here
		// too would briefly show it twice over.
		margin.innerHTML = "";
		margin.appendChild(
			renderLinksToFragment(
				normalizeText(this.content),
				this.host.app,
			),
		);

		// Signal that reading mode needs a refresh if the user switches modes
		if (result.changed) {
			this.host.needsReadingModeRefresh = true;
			this.host.refreshCachedSourceContent();
		}

		// The margin just swapped a CM editor for rendered text, so its height
		// changed and every sidenote below it is now mispositioned.
		this.host.scheduleCollisionUpdate();
	}

	private commitFootnoteText(newText: string) {
		const view =
			this.host.app.workspace.getActiveViewOfType(MarkdownView);
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
			// Let clicks on links through so they can navigate normally
			if ((e.target as HTMLElement).closest("a")) {
				return;
			}
			// Stop propagation so CM6 main editor doesn't steal focus/click
			e.stopPropagation();
			// Let click focus our margin editor
		};

		const onClick = (e: MouseEvent) => {
			// If already editing, let CM handle cursor
			if (this.marginEditor) {
				e.stopPropagation();
				return;
			}

			// Let clicks on links through so they can navigate normally
			if ((e.target as HTMLElement).closest("a")) {
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
		if (this.marginEditor) return;

		this.host.setActiveFootnoteEdit(this.footnoteId);
		margin.dataset.editing = "true";
		margin.innerHTML = "";

		// Set by the insert-sidenote command so a freshly created footnote
		// opens with its placeholder text selected, ready to type over.
		const selectAll = margin.dataset.selectAllOnOpen === "true";
		delete margin.dataset.selectAllOnOpen;

		this.marginEditor = openInlineMarkdownEditor({
			app: this.host.app,
			parent: margin,
			doc: this.content,
			selectAll,
			outsideBoundary: [margin],
			onClose: (result) => this.afterMarginEdit(margin, result),
		});

		// Opening the editor grows the margin; push the ones below it down.
		this.host.scheduleCollisionUpdate();
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

class MarginNoteMarkerWidget extends WidgetType {
	constructor(
		readonly host: SidenoteWidgetHost,
		readonly footnoteId: string,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const span = createSpan();
		span.className = "margin-note-marker";

		const iconSetting = this.host.settings.popupIcon || "ⓘ";

		if (
			iconSetting.endsWith(".png") ||
			iconSetting.endsWith(".svg") ||
			iconSetting.endsWith(".jpg")
		) {
			const img = createEl("img");
			img.src = this.host.app.vault.adapter.getResourcePath(
				`${this.host.manifest.dir}/assets/${iconSetting}`,
			);
			img.className = "margin-note-marker-img";
			span.appendChild(img);
		} else {
			span.textContent = iconSetting;
		}

		span.addEventListener("mousedown", (e) => {
			e.stopPropagation();
		});

		span.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();

			const cmContent = span.closest(".cm-content");
			if (!cmContent) return;
			const wrapper = cmContent.querySelector<HTMLElement>(
				`span.sidenote-number[data-footnote-id="${this.footnoteId}"]`,
			);
			if (!wrapper) return;

			if (this.host.settings.marginNoteDisplay === "popup") {
				const popupIcon = wrapper.querySelector<HTMLElement>(
					".margin-note-icon",
				);
				if (popupIcon) popupIcon.click();
			} else {
				const marginEl = wrapper.querySelector<HTMLElement>(
					"small.sidenote-margin",
				);
				if (marginEl) marginEl.click();
			}
		});

		return span;
	}

	eq(other: MarginNoteMarkerWidget): boolean {
		return this.footnoteId === other.footnoteId;
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
	private lastSettingsVersion: number;
	private lastLivePreview: boolean;

	constructor(
		private view: EditorView,
		private host: SidenoteWidgetHost,
	) {
		this.lastSettingsVersion = host.settingsVersion;
		this.lastLivePreview = this.isLivePreview(view.state);
		this.decorations = this.buildDecorations(view.state);
	}

	/**
	 * Source mode shows the raw markdown, so sidenotes stay out of it.
	 * The field is absent in the plugin's own margin editors — treat that
	 * as "not a source-mode editor".
	 */
	private isLivePreview(state: EditorState): boolean {
		return state.field(editorLivePreviewField, false) !== false;
	}

	update(update: ViewUpdate) {
		// Don't rebuild decorations while a footnote is being edited
		if (this.host.isFootnoteBeingEdited()) {
			return;
		}

		const settingsChanged =
			this.host.settingsVersion !== this.lastSettingsVersion;

		const livePreview = this.isLivePreview(update.state);
		const modeChanged = livePreview !== this.lastLivePreview;

		if (
			update.docChanged ||
			update.viewportChanged ||
			update.geometryChanged ||
			settingsChanged ||
			modeChanged
		) {
			this.lastSettingsVersion = this.host.settingsVersion;
			this.lastLivePreview = livePreview;
			this.decorations = this.buildDecorations(update.state);
		}
	}

	/* */
	buildDecorations(state: EditorState): DecorationSet {
		// Only show footnote sidenotes in editing mode when using footnote-edit format
		if (this.host.settings.sidenoteFormat !== "footnote-edit") {
			return Decoration.none;
		}

		// Source mode renders the bare markdown — no sidenotes
		if (!this.isLivePreview(state)) {
			return Decoration.none;
		}

		const decorations: { from: number; decoration: Decoration }[] = [];
		const content = state.doc.toString();

		// Parse footnote definitions first
		const footnoteDefinitions =
			parseFootnoteDefinitions(content);

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

		// Assign numbers based on order of appearance, skipping margin notes
		const footnoteNumbers = new Map<string, number>();
		let counter = 1;
		footnoteOrder.forEach((id) => {
			if (id.startsWith("mn-")) {
				footnoteNumbers.set(id, -1); // Margin note, no number
			} else {
				footnoteNumbers.set(id, counter++);
			}
		});

		// Second pass: create decorations
		while ((match = referenceRegex.exec(content)) !== null) {
			const from = match.index;
			const to = from + match[0].length;
			const id = match[1];

			if (!id) continue;

			const footnoteContent = footnoteDefinitions.get(id);
			if (!footnoteContent) continue;

			const isMargin = id.startsWith("mn-");
			const itemNum = footnoteNumbers.get(id) ?? 1;
			const numberText = isMargin
				? ""
				: formatNumber(itemNum, this.host.settings.numberStyle);

			if (isMargin) {
				decorations.push({
					from: to,
					decoration: Decoration.widget({
						widget: new MarginNoteMarkerWidget(this.host, id),
						side: -1,
					}),
				});
			}

			decorations.push({
				from: to,
				decoration: Decoration.widget({
					widget: new FootnoteSidenoteWidget(
						footnoteContent,
						numberText,
						id,
						this.host,
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
export function createFootnoteSidenotePlugin(host: SidenoteWidgetHost) {
	return ViewPlugin.fromClass(
		class {
			inner: FootnoteSidenoteViewPlugin;

			constructor(view: EditorView) {
				this.inner = new FootnoteSidenoteViewPlugin(view, host);
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
