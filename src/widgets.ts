import {
	MarkdownView,
	TFile,
	EditorPosition,
	editorLivePreviewField,
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
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
// eslint-disable-next-line import/no-extraneous-dependencies
import { tags } from "@lezer/highlight";
import { setCssProps } from "../dom-utils";
import type SidenotePlugin from "../main";

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

type WorkspaceWithActiveEditor = {
	activeEditor: null | {
		editor: MinimalEditor;
		file: TFile | null;
	};
};

export function setWorkspaceActiveEditor(
	plugin: SidenotePlugin,
	view: EditorView | null,
) {
	const ws = plugin.app.workspace as unknown as WorkspaceWithActiveEditor;

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

export const markdownEditHotkeys = keymap.of([
	{ key: "Mod-b", run: mdBold, preventDefault: true },
	{ key: "Mod-i", run: mdItalic, preventDefault: true },
	{ key: "Mod-k", run: mdLink, preventDefault: true },
]);

export const sidenoteEditorTheme = EditorView.theme({
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

export const sidenoteHighlightStyle = HighlightStyle.define([
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
		const isMargin = this.plugin.isMarginNote(this.footnoteId);

		const wrapper = document.createElement("span");
		wrapper.className = "sidenote-number";

		wrapper.dataset.sidenoteNum = this.numberText;
		wrapper.dataset.footnoteId = this.footnoteId;

		const margin = document.createElement("small");
		margin.className = "sidenote-margin";
		if (isMargin) {
			margin.classList.add("margin-note");
			wrapper.classList.add("margin-note");
		}

		margin.dataset.sidenoteNum = this.numberText;
		margin.style.setProperty("--sidenote-shift", "0px");
		margin.style.setProperty("--sidenote-line-offset", "0px");

		// Render the content with markdown formatting support
		const fragment = this.plugin.renderLinksToFragmentPublic(
			this.plugin.normalizeTextPublic(this.content),
		);
		margin.appendChild(fragment);

		// Setup popup
		if (isMargin && this.plugin.settings.marginNoteDisplay === "popup") {
			this.plugin.setupMarginNotePopupPublic(
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

		// Track height changes on this margin (inline editor open/close, late
		// image loads) so collisions get re-resolved instead of going stale.
		this.plugin.observeSidenoteMarginPublic(margin);

		return wrapper;
	}

	destroy(dom: HTMLElement): void {
		const margin = dom.querySelector<HTMLElement>("small.sidenote-margin");
		if (margin) this.plugin.unobserveSidenoteMarginPublic(margin);
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

		// The margin just swapped a CM editor for rendered text, so its height
		// changed and every sidenote below it is now mispositioned.
		this.plugin.scheduleEditingModeCollisionUpdate();
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

		// Opening the editor grows the margin; push the ones below it down.
		this.plugin.scheduleEditingModeCollisionUpdate();
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
		readonly plugin: SidenotePlugin,
		readonly footnoteId: string,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = "margin-note-marker";

		const iconSetting = this.plugin.settings.popupIcon || "ⓘ";

		if (
			iconSetting.endsWith(".png") ||
			iconSetting.endsWith(".svg") ||
			iconSetting.endsWith(".jpg")
		) {
			const img = document.createElement("img");
			img.src = this.plugin.app.vault.adapter.getResourcePath(
				`${this.plugin.manifest.dir}/assets/${iconSetting}`,
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

			if (this.plugin.settings.marginNoteDisplay === "popup") {
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
		private plugin: SidenotePlugin,
	) {
		this.lastSettingsVersion = plugin.settingsVersion;
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
		if (this.plugin.isFootnoteBeingEdited()) {
			return;
		}

		const settingsChanged =
			this.plugin.settingsVersion !== this.lastSettingsVersion;

		const livePreview = this.isLivePreview(update.state);
		const modeChanged = livePreview !== this.lastLivePreview;

		if (
			update.docChanged ||
			update.viewportChanged ||
			update.geometryChanged ||
			settingsChanged ||
			modeChanged
		) {
			this.lastSettingsVersion = this.plugin.settingsVersion;
			this.lastLivePreview = livePreview;
			this.decorations = this.buildDecorations(update.state);
		}
	}

	/* */
	buildDecorations(state: EditorState): DecorationSet {
		// Only show footnote sidenotes in editing mode when using footnote-edit format
		if (this.plugin.settings.sidenoteFormat !== "footnote-edit") {
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
				: this.plugin.formatNumberPublic(itemNum);

			if (isMargin) {
				decorations.push({
					from: to,
					decoration: Decoration.widget({
						widget: new MarginNoteMarkerWidget(this.plugin, id),
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
export function createFootnoteSidenotePlugin(plugin: SidenotePlugin) {
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
