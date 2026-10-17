import type { Editor, Menu, Plugin } from "obsidian";
import {
	insertNote,
	type InsertNoteContext,
	type InsertNoteVariant,
} from "./insert-note";
import {
	resequenceFootnotes,
	type ResequenceContext,
} from "./resequence-footnotes";

export type CommandHost = InsertNoteContext & ResequenceContext;

/**
 * Command IDs are stable API — never rename one once released.
 * See AGENTS.md, "Commands & settings".
 */
const INSERT_COMMANDS: {
	id: string;
	name: string;
	variant: InsertNoteVariant;
}[] = [
	{
		id: "insert-sidenote",
		name: "Insert sidenote",
		variant: { marginNote: false, oppositeMargin: false },
	},
	{
		id: "insert-sidenote-opposite-margin",
		name: "Insert sidenote (opposite margin, experimental)",
		variant: { marginNote: false, oppositeMargin: true },
	},
	{
		id: "insert-margin-note",
		name: "Insert margin note",
		variant: { marginNote: true, oppositeMargin: false },
	},
	{
		id: "insert-margin-note-opposite-margin",
		name: "Insert margin note (opposite margin, experimental)",
		variant: { marginNote: true, oppositeMargin: true },
	},
];

export function registerSidenoteCommands(plugin: Plugin, host: CommandHost) {
	for (const { id, name, variant } of INSERT_COMMANDS) {
		plugin.addCommand({
			id,
			name,
			editorCallback: (editor: Editor) => insertNote(host, editor, variant),
		});
	}

	plugin.addCommand({
		id: "resequence-footnotes",
		name: "Resequence footnotes (if out of order)",
		editorCallback: (editor: Editor) => resequenceFootnotes(host, editor),
	});

	plugin.registerEvent(
		plugin.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
			if (!editor.somethingSelected()) return;

			const selection = {
				from: editor.getCursor("from"),
				to: editor.getCursor("to"),
			};
			const defaultSide =
				host.settings.sidenotePosition === "left" ? "left" : "right";
			const oppositeSide = defaultSide === "left" ? "right" : "left";

			menu.addSeparator();

			for (const { variant } of INSERT_COMMANDS) {
				const side = variant.oppositeMargin
					? oppositeSide
					: defaultSide;
				const label = variant.marginNote ? "margin note" : "sidenote";

				menu.addItem((item) =>
					item
						.setTitle(`Insert ${label} (${side})`)
						.setIcon(
							variant.marginNote ? "message-square" : "sticky-note",
						)
						.onClick(() => {
							editor.setSelection(selection.from, selection.to);
							insertNote(host, editor, variant);
						}),
				);
			}
		}),
	);
}
