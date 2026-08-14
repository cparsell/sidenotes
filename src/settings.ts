import {
	PluginSettingTab,
	Setting,
	App,
	SettingDefinitionItem,
} from "obsidian";

import SidenotePlugin from "./main";

// Settings interface
export interface SidenoteSettings {
	// Source format
	sidenoteFormat: "html" | "footnote" | "footnote-edit";
	hideFootnotes: boolean;
	hideFootnoteNumbers: boolean;

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
	sidenoteGap2: number;
	sidenoteGapDrift: number;
	sidenoteAnchor: "text" | "edge";
	/**
	 * Not user-configurable — retained only so older `data.json` files with a
	 * stored value don't error, and pinned to 1 wherever it's read
	 * (main.ts saveSettings/loadSettings). 1 reserves exactly the space a
	 * sidenote needs to push the body text aside without clipping. Any other
	 * value either clips the sidenote or narrows the text to open unwanted
	 * space at the pane edge — see the "page offset factor" removal note in
	 * settings.ts's UI section for the reasoning.
	 */
	pageOffsetFactor: number;

	// Breakpoints
	hideBelow: number;
	compactBelow: number;
	fullAbove: number;

	// Typography
	fontSize: number;
	fontSizeCompact: number;
	lineHeight: number;
	textColor: string;
	hoverColor: string;
	textAlignment: "left" | "right" | "justify";

	// Behavior
	collisionSpacing: number;
	enableTransitions: boolean;
	resetNumberingPerHeading: boolean;
	pdfExport: boolean;

	// Margin note

	marginNoteDisplay: "margin" | "popup";
	popupIcon: string;
	marginNoteScaleFactor: number;
	popupIconScaleFactor: number;
}

export const DEFAULT_SETTINGS: SidenoteSettings = {
	// Source format
	sidenoteFormat: "html",
	hideFootnotes: false,
	hideFootnoteNumbers: true,

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
	sidenoteGap2: 1,
	sidenoteGapDrift: 0.3,
	sidenoteAnchor: "text",
	pageOffsetFactor: 1,

	// Breakpoints
	hideBelow: 900,
	compactBelow: 1000,
	fullAbove: 1450,

	// Typography
	fontSize: 80,
	fontSizeCompact: 70,
	lineHeight: 1.35,
	textColor: "",
	hoverColor: "",
	textAlignment: "left",

	// Behavior
	collisionSpacing: 8,
	enableTransitions: true,
	resetNumberingPerHeading: false,
	pdfExport: false,

	// Margin note
	marginNoteDisplay: "margin",
	popupIcon: "ⓘ",
	marginNoteScaleFactor: 1,
	popupIconScaleFactor: 1,
};

// ======================================================
// ==================== Settings Tab ====================
// ======================================================

/** Static "how the Markdown shorthand maps to output" reference block. */
function renderFormattingHelp(container: HTMLElement): void {
	container.createEl("p", {
		text: "Sidenotes support basic Markdown formatting:",
	});

	const list = container.createEl("ul");

	const item = (build: (li: HTMLLIElement) => void) => {
		build(list.createEl("li"));
	};

	item((li) => {
		li.createEl("code", { text: "**bold**" });
		li.appendText(" or ");
		li.createEl("code", { text: "__bold__" });
		li.appendText(" → ");
		li.createEl("strong", { text: "bold" });
	});
	item((li) => {
		li.createEl("code", { text: "*italic*" });
		li.appendText(" or ");
		li.createEl("code", { text: "_italic_" });
		li.appendText(" → ");
		li.createEl("em", { text: "italic" });
	});
	item((li) => {
		li.createEl("code", { text: "`code`" });
		li.appendText(" → ");
		li.createEl("code", { text: "code" });
	});
	item((li) => {
		li.createEl("code", { text: "[link](url)" });
		li.appendText(" → clickable link");
	});
	item((li) => {
		li.createEl("code", { text: "[[Note]]" });
		li.appendText(" or ");
		li.createEl("code", { text: "[[Note|display]]" });
		li.appendText(" → internal link");
	});

	container.createEl("p", {
		text: "Use the command palette to insert sidenotes quickly.",
	});

	container.createEl("p", {
		text: "Pin an individual sidenote to the opposite margin from the 'Sidenote position' setting:",
	});

	const sideList = container.createEl("ul");
	const sideItem = (build: (li: HTMLLIElement) => void) => {
		build(sideList.createEl("li"));
	};

	sideItem((li) => {
		li.appendText("HTML format: add a ");
		li.createEl("code", { text: "right" });
		li.appendText(" or ");
		li.createEl("code", { text: "left" });
		li.appendText(" class, e.g. ");
		li.createEl("code", {
			text: '<span class="sidenote right">text</span>',
		});
	});
	sideItem((li) => {
		li.appendText("Footnote format: append ");
		li.createEl("code", { text: "-r" });
		li.appendText(" or ");
		li.createEl("code", { text: "-l" });
		li.appendText(" to the footnote ID, e.g. ");
		li.createEl("code", { text: "[^3-r]" });
		li.appendText(" (composes with margin notes: ");
		li.createEl("code", { text: "[^mn-2-l]" });
		li.appendText(")");
	});
}

export class SidenoteSettingTab extends PluginSettingTab {
	plugin: SidenotePlugin;

	constructor(app: App, plugin: SidenotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Sidenote format").setHeading();

		new Setting(containerEl)
			.setName("Sidenote format")
			.setDesc("Choose how sidenotes are written in your documents")
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						"html",
						'HTML spans: <span class="sidenote">text</span>',
					)
					//.addOption("footnote", "Footnotes (reading mode only)")
					.addOption(
						"footnote-edit",
						"Footnotes (reading + editing mode) [experimental]",
					)
					.setValue(this.plugin.settings.sidenoteFormat)
					.onChange(async (value: "html" | "footnote-edit") => {
						this.plugin.settings.sidenoteFormat = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("If using footnotes").setHeading();

		new Setting(containerEl)
			.setName("Hide footnotes")
			.setDesc(
				"Hides the footnotes at the bottom of the document (only relevant if using footnote format)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideFootnotes)
					.onChange(async (value) => {
						this.plugin.settings.hideFootnotes = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Hide footnote numbers in text")
			.setDesc(
				"Hides the Markdown style footnote reference numbers in the text body, and replaces with sidenote numbers only (only relevant if using footnote format)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideFootnoteNumbers)
					.onChange(async (value) => {
						this.plugin.settings.hideFootnoteNumbers = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Display").setHeading();

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

		new Setting(containerEl).setName("Width & spacing").setHeading();

		new Setting(containerEl)
			.setName("Sidenote anchor")
			.setDesc(
				"Whether sidenotes are positioned relative to the text body or the editor edge",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("text", "Anchor to text (traditional)")
					.addOption("edge", "Anchor to editor edge")
					.setValue(this.plugin.settings.sidenoteAnchor)
					.onChange(async (value: "text" | "edge") => {
						this.plugin.settings.sidenoteAnchor = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Minimum sidenote width")
			.setDesc("Base width of sidenotes in rem (default: 10)")
			.addSlider((slider) =>
				slider
					.setLimits(5, 25, 1)
					.setValue(this.plugin.settings.minSidenoteWidth)
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
					.onChange(async (value) => {
						this.plugin.settings.maxSidenoteWidth = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Minimum gap between sidenote and text")
			.setDesc(
				"Space between the margin and body text in rem (default: 2)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 30, 0.5)
					.setValue(this.plugin.settings.sidenoteGap)
					.onChange(async (value) => {
						this.plugin.settings.sidenoteGap = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Minimum gap between sidenote and editor edge")
			.setDesc(
				"When anchored to text: minimum distance from editor edge. When anchored to edge: minimum distance from text body. (rem, default: 1)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 10, 0.5)
					.setValue(this.plugin.settings.sidenoteGap2)
					.onChange(async (value) => {
						this.plugin.settings.sidenoteGap2 = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Gap drift factor")
			.setDesc(
				"Adjusts how much the gaps grow as editor width increases (default: 0.5). At 0, gaps stay at their minimum. At 1, gaps grow by the maximum amount (20% of extra space).",
			)
			.addSlider((slider) =>
				slider
					.setLimits(-1, 1, 0.1)
					.setValue(this.plugin.settings.sidenoteGapDrift)
					.onChange(async (value) => {
						this.plugin.settings.sidenoteGapDrift = value;
						await this.plugin.saveSettings();
					}),
			);

		// No "page offset factor" control here. The body text is pushed over
		// by exactly the space a sidenote needs — a fixed 1:1 relationship,
		// not a user-adjustable one. Any value other than "exactly enough"
		// either clips the sidenote off the pane (less) or shifts the sidenote
		// and text together, purely narrowing the text to open a gap at the
		// pane edge nobody asked for (more). See pageOffsetFactor in
		// settings.ts for the values this is pinned to.

		new Setting(containerEl).setName("Breakpoints").setHeading();

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

		new Setting(containerEl).setName("Typography").setHeading();

		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Font size as percentage of body text (default: 80)")
			.addSlider((slider) =>
				slider
					.setLimits(50, 100, 5)
					.setValue(this.plugin.settings.fontSize)
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
					.onChange(async (value) => {
						this.plugin.settings.lineHeight = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sidenote text color")
			.setDesc(
				"Color for sidenote text. Leave empty to use Obsidian's default text color.",
			)
			.addText((text) =>
				text
					.setPlaceholder("E.g. #333333 or rgb(50,50,50)")
					.setValue(this.plugin.settings.textColor)
					.onChange(async (value) => {
						this.plugin.settings.textColor = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sidenote hover color")
			.setDesc(
				"Color for sidenote text *on hover*. Leave empty to use Obsidian's default *muted text* color.",
			)
			.addText((text) =>
				text
					.setPlaceholder("E.g. #333333 or rgb(50,50,50)")
					.setValue(this.plugin.settings.hoverColor)
					.onChange(async (value) => {
						this.plugin.settings.hoverColor = value.trim();
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

		new Setting(containerEl).setName("Behavior").setHeading();

		new Setting(containerEl)
			.setName("Collision spacing")
			.setDesc("Minimum pixels between stacked sidenotes (default: 8)")
			.addSlider((slider) =>
				slider
					.setLimits(0, 20, 1)
					.setValue(this.plugin.settings.collisionSpacing)
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

		new Setting(containerEl)
			.setName("Include sidenotes in PDF export (experimental)")
			.setDesc(
				"When enabled, sidenotes will be included in PDF exports, in the margin rather than inline. Works with both the HTML and footnote formats. Note: this may cause formatting issues in some cases.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.pdfExport)
					.onChange(async (value) => {
						this.plugin.settings.pdfExport = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Margin notes").setHeading();
		new Setting(containerEl)
			.setName("Margin note display")
			.setDesc(
				"Show margin notes in the margin, or as an ⓘ icon with a popup on click.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("margin", "Show in margin")
					.addOption("popup", "Show as popup on click")
					.setValue(this.plugin.settings.marginNoteDisplay)
					.onChange(async (value) => {
						this.plugin.settings.marginNoteDisplay = value as
							| "margin"
							| "popup";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Margin note popup icon")
			.setDesc(
				"Specify an icon to use for margin notes when 'Show as popup on click' is selected. You can use any Unicode character, e.g. ⓘ or 🛈, or a filename (stored in plugins/sidenotes/assets)",
			)
			.addText((text) =>
				text
					.setPlaceholder("E.g. ⓘ or 🛈 or information_source.png")
					.setValue(this.plugin.settings.popupIcon)
					.onChange(async (value) => {
						this.plugin.settings.popupIcon = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Margin note marker scale factor")
			.setDesc(
				"Scale factor for margin note icon placed in the main note (default: 1)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.1, 3, 0.1)
					.setValue(this.plugin.settings.marginNoteScaleFactor)
					.onChange(async (value) => {
						this.plugin.settings.marginNoteScaleFactor = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Margin note popup icon scale factor")
			.setDesc(
				"Scale factor for margin note popup icons - only applies if using popup mode for margin notes(default: 1)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.1, 3, 0.1)
					.setValue(this.plugin.settings.popupIconScaleFactor)
					.onChange(async (value) => {
						this.plugin.settings.popupIconScaleFactor = value;
						await this.plugin.saveSettings();
					}),
			);

		// Help section
		new Setting(containerEl).setName("Formatting help").setHeading();

		const helpDiv = containerEl.createDiv({ cls: "sidenote-help" });
		renderFormattingHelp(helpDiv);
	}

	// ==================== Declarative settings (Obsidian 1.13+) ====================
	// Mirrors display() above so settings surface in Obsidian's settings
	// search. display() is left in place for older Obsidian versions, which
	// don't call getSettingDefinitions().

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[
			key
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings as unknown as Record<
			string,
			unknown
		>;
		settings[key] = typeof value === "string" ? value.trim() : value;
		await this.plugin.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = DEFAULT_SETTINGS;

		return [
			{
				type: "group",
				heading: "Sidenote format",
				items: [
					{
						name: "Sidenote format",
						desc: "Choose how sidenotes are written in your documents",
						control: {
							type: "dropdown",
							key: "sidenoteFormat",
							defaultValue: s.sidenoteFormat,
							options: {
								html: 'HTML spans: <span class="sidenote">text</span>',
								"footnote-edit":
									"Footnotes (reading + editing mode) [experimental]",
							},
						},
					},
				],
			},
			{
				type: "group",
				heading: "If using footnotes",
				items: [
					{
						name: "Hide footnotes",
						desc: "Hides the footnotes at the bottom of the document (only relevant if using footnote format)",
						control: {
							type: "toggle",
							key: "hideFootnotes",
							defaultValue: s.hideFootnotes,
						},
					},
					{
						name: "Hide footnote numbers in text",
						desc: "Hides the Markdown style footnote reference numbers in the text body, and replaces with sidenote numbers only (only relevant if using footnote format)",
						control: {
							type: "toggle",
							key: "hideFootnoteNumbers",
							defaultValue: s.hideFootnoteNumbers,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Display",
				items: [
					{
						name: "Sidenote position",
						desc: "Which margin to display sidenotes in (text will be offset to the opposite side)",
						control: {
							type: "dropdown",
							key: "sidenotePosition",
							defaultValue: s.sidenotePosition,
							options: { left: "Left margin", right: "Right margin" },
						},
					},
					{
						name: "Show sidenote numbers",
						desc: "Display reference numbers in text and sidenotes",
						control: {
							type: "toggle",
							key: "showSidenoteNumbers",
							defaultValue: s.showSidenoteNumbers,
						},
					},
					{
						name: "Number style",
						desc: "How to format sidenote numbers",
						control: {
							type: "dropdown",
							key: "numberStyle",
							defaultValue: s.numberStyle,
							options: {
								arabic: "Arabic (1, 2, 3)",
								roman: "Roman (i, ii, iii)",
								letters: "Letters (a, b, c)",
							},
						},
					},
					{
						name: "Number badge style",
						desc: "Visual style for sidenote numbers",
						control: {
							type: "dropdown",
							key: "numberBadgeStyle",
							defaultValue: s.numberBadgeStyle,
							options: {
								plain: "Plain (superscript)",
								neumorphic: "Neumorphic (subtle badge)",
								pill: "Pill (colored capsule)",
							},
						},
					},
					{
						name: "Number color",
						desc: "Custom color for sidenote numbers (leave empty for theme default)",
						control: {
							type: "text",
							key: "numberColor",
							defaultValue: s.numberColor,
							placeholder: "#666666 or rgb(100,100,100)",
						},
					},
				],
			},
			{
				type: "group",
				heading: "Width & spacing",
				items: [
					{
						name: "Sidenote anchor",
						desc: "Whether sidenotes are positioned relative to the text body or the editor edge",
						control: {
							type: "dropdown",
							key: "sidenoteAnchor",
							defaultValue: s.sidenoteAnchor,
							options: {
								text: "Anchor to text (traditional)",
								edge: "Anchor to editor edge",
							},
						},
					},
					{
						name: "Minimum sidenote width",
						desc: "Base width of sidenotes in rem (default: 10)",
						control: {
							type: "slider",
							key: "minSidenoteWidth",
							defaultValue: s.minSidenoteWidth,
							min: 5,
							max: 25,
							step: 1,
						},
					},
					{
						name: "Maximum sidenote width",
						desc: "Maximum width of sidenotes in rem (default: 18)",
						control: {
							type: "slider",
							key: "maxSidenoteWidth",
							defaultValue: s.maxSidenoteWidth,
							min: 10,
							max: 40,
							step: 1,
						},
					},
					{
						name: "Minimum gap between sidenote and text",
						desc: "Space between the margin and body text in rem (default: 2)",
						control: {
							type: "slider",
							key: "sidenoteGap",
							defaultValue: s.sidenoteGap,
							min: 0.5,
							max: 30,
							step: 0.5,
						},
					},
					{
						name: "Minimum gap between sidenote and editor edge",
						desc: "When anchored to text: minimum distance from editor edge. When anchored to edge: minimum distance from text body. (rem, default: 1)",
						control: {
							type: "slider",
							key: "sidenoteGap2",
							defaultValue: s.sidenoteGap2,
							min: 0,
							max: 10,
							step: 0.5,
						},
					},
					{
						name: "Gap drift factor",
						desc: "Adjusts how much the gaps grow as editor width increases (default: 0.5). At 0, gaps stay at their minimum. At 1, gaps grow by the maximum amount (20% of extra space).",
						control: {
							type: "slider",
							key: "sidenoteGapDrift",
							defaultValue: s.sidenoteGapDrift,
							min: -1,
							max: 1,
							step: 0.1,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Breakpoints",
				items: [
					{
						name: "Hide below width",
						desc: "Hide sidenotes when editor width is below this (px)",
						control: {
							type: "number",
							key: "hideBelow",
							defaultValue: s.hideBelow,
							placeholder: "700",
							min: 1,
							validate: (value) =>
								value > 0 ? undefined : "Must be greater than 0",
						},
					},
					{
						name: "Compact below width",
						desc: "Use compact mode when editor width is below this (px)",
						control: {
							type: "number",
							key: "compactBelow",
							defaultValue: s.compactBelow,
							placeholder: "900",
							min: 1,
							validate: (value) =>
								value > 0 ? undefined : "Must be greater than 0",
						},
					},
					{
						name: "Full width above",
						desc: "Use full-width sidenotes when editor width is above this (px)",
						control: {
							type: "number",
							key: "fullAbove",
							defaultValue: s.fullAbove,
							placeholder: "1400",
							min: 1,
							validate: (value) =>
								value > 0 ? undefined : "Must be greater than 0",
						},
					},
				],
			},
			{
				type: "group",
				heading: "Typography",
				items: [
					{
						name: "Font size",
						desc: "Font size as percentage of body text (default: 80)",
						control: {
							type: "slider",
							key: "fontSize",
							defaultValue: s.fontSize,
							min: 50,
							max: 100,
							step: 5,
						},
					},
					{
						name: "Font size (compact mode)",
						desc: "Font size in compact mode as percentage (default: 70)",
						control: {
							type: "slider",
							key: "fontSizeCompact",
							defaultValue: s.fontSizeCompact,
							min: 50,
							max: 100,
							step: 5,
						},
					},
					{
						name: "Line height",
						desc: "Line height for sidenote text (default: 1.35)",
						control: {
							type: "slider",
							key: "lineHeight",
							defaultValue: s.lineHeight,
							min: 1,
							max: 2,
							step: 0.05,
						},
					},
					{
						name: "Sidenote text color",
						desc: "Color for sidenote text. Leave empty to use Obsidian's default text color.",
						control: {
							type: "text",
							key: "textColor",
							defaultValue: s.textColor,
							placeholder: "E.g. #333333 or rgb(50,50,50)",
						},
					},
					{
						name: "Sidenote hover color",
						desc: "Color for sidenote text *on hover*. Leave empty to use Obsidian's default *muted text* color.",
						control: {
							type: "text",
							key: "hoverColor",
							defaultValue: s.hoverColor,
							placeholder: "E.g. #333333 or rgb(50,50,50)",
						},
					},
					{
						name: "Text alignment",
						desc: "How to align text in sidenotes",
						control: {
							type: "dropdown",
							key: "textAlignment",
							defaultValue: s.textAlignment,
							options: { left: "Left", right: "Right", justify: "Justified" },
						},
					},
				],
			},
			{
				type: "group",
				heading: "Behavior",
				items: [
					{
						name: "Collision spacing",
						desc: "Minimum pixels between stacked sidenotes (default: 8)",
						control: {
							type: "slider",
							key: "collisionSpacing",
							defaultValue: s.collisionSpacing,
							min: 0,
							max: 20,
							step: 1,
						},
					},
					{
						name: "Enable smooth transitions",
						desc: "Animate width and position changes",
						control: {
							type: "toggle",
							key: "enableTransitions",
							defaultValue: s.enableTransitions,
						},
					},
					{
						name: "Reset numbering per heading",
						desc: "Restart sidenote numbering after each heading",
						control: {
							type: "toggle",
							key: "resetNumberingPerHeading",
							defaultValue: s.resetNumberingPerHeading,
						},
					},
					{
						name: "Include sidenotes in PDF export (experimental)",
						desc: "When enabled, sidenotes will be included in PDF exports, in the margin rather than inline. Works with both the HTML and footnote formats. Note: this may cause formatting issues in some cases.",
						control: {
							type: "toggle",
							key: "pdfExport",
							defaultValue: s.pdfExport,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Margin notes",
				items: [
					{
						name: "Margin note display",
						desc: "Show margin notes in the margin, or as an ⓘ icon with a popup on click.",
						control: {
							type: "dropdown",
							key: "marginNoteDisplay",
							defaultValue: s.marginNoteDisplay,
							options: {
								margin: "Show in margin",
								popup: "Show as popup on click",
							},
						},
					},
					{
						name: "Margin note popup icon",
						desc: "Specify an icon to use for margin notes when 'Show as popup on click' is selected. You can use any Unicode character, e.g. ⓘ or 🛈, or a filename (stored in plugins/sidenotes/assets)",
						control: {
							type: "text",
							key: "popupIcon",
							defaultValue: s.popupIcon,
							placeholder: "E.g. ⓘ or 🛈 or information_source.png",
						},
					},
					{
						name: "Margin note marker scale factor",
						desc: "Scale factor for margin note icon placed in the main note (default: 1)",
						control: {
							type: "slider",
							key: "marginNoteScaleFactor",
							defaultValue: s.marginNoteScaleFactor,
							min: 0.1,
							max: 3,
							step: 0.1,
						},
					},
					{
						name: "Margin note popup icon scale factor",
						desc: "Scale factor for margin note popup icons - only applies if using popup mode for margin notes(default: 1)",
						control: {
							type: "slider",
							key: "popupIconScaleFactor",
							defaultValue: s.popupIconScaleFactor,
							min: 0.1,
							max: 3,
							step: 0.1,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Formatting help",
				items: [
					{
						name: "",
						render: (setting) => {
							setting.settingEl.empty();
							setting.settingEl.addClass("sidenote-help");
							renderFormattingHelp(setting.settingEl);
						},
					},
				],
			},
		];
	}
}
