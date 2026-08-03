import type { Editor, Plugin } from "obsidian";
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
}
