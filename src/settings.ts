/* eslint-disable obsidianmd/ui/sentence-case */
import { PluginSettingTab, Setting, App } from "obsidian";

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
	sidenoteAnchor: "text" | "edge";
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
	editInReadingMode: boolean;
	pdfExport: boolean;
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
	sidenoteAnchor: "text",
	pageOffsetFactor: 0.3,

	// Breakpoints
	hideBelow: 700,
	compactBelow: 1200,
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
	editInReadingMode: false,
	pdfExport: false,
};

// ======================================================
// ==================== Settings Tab ====================
// ======================================================

export class SidenoteSettingTab extends PluginSettingTab {
	plugin: SidenotePlugin;

	constructor(app: App, plugin: SidenotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Sidenote Format").setHeading();

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

		new Setting(containerEl).setName("If using Footnotes").setHeading();

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

		new Setting(containerEl).setName("Width & Spacing").setHeading();

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
			.setName("Minimum Gap between sidenote and text")
			.setDesc(
				"Space between the margin and body text in rem (default: 2)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 30, 0.5)
					.setValue(this.plugin.settings.sidenoteGap)
					.setDynamicTooltip()
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
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.sidenoteGap2 = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Page Offset Factor")
			.setDesc(
				"Adjusts how much body text gets nudged over when sidenotes are present (default: 0)",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.1)
					.setValue(this.plugin.settings.pageOffsetFactor)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.pageOffsetFactor = value;
						await this.plugin.saveSettings();
					}),
			);

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
			.setName("Sidenote text color")
			.setDesc(
				"Color for sidenote text. Leave empty to use Obsidian's default text color.",
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g. #333333 or rgb(50,50,50)")
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
					.setPlaceholder("e.g. #333333 or rgb(50,50,50)")
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

		new Setting(containerEl)
			.setName("Allow Sidenote Edits in reading mode")
			.setDesc(
				"Click a sidenote in reading mode to edit the footnote text inline (only relevant if using footnote format)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.editInReadingMode)
					.onChange(async (value) => {
						this.plugin.settings.editInReadingMode = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(
				"Include sidenotes in PDF export (HTML only - experimental)",
			)
			.setDesc(
				"When enabled, sidenotes will be included in PDF exports. Note: this may cause formatting issues in some cases, and is not compatible with the Footnote format *yet*.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.pdfExport as boolean)
					.onChange(async (value) => {
						this.plugin.settings.pdfExport = value;
						await this.plugin.saveSettings();
					}),
			);

		// Help section
		new Setting(containerEl).setName("Formatting Help").setHeading();

		const helpDiv = containerEl.createDiv({ cls: "sidenote-help" });
		helpDiv.innerHTML = `
            <p>Sidenotes support basic Markdown formatting:</p>
            <ul>
                <li><code>**bold**</code> or <code>__bold__</code> → <strong>bold</strong></li>
                <li><code>*italic*</code> or <code>_italic_</code> → <em>italic</em></li>
                <li><code>\`code\`</code> → <code>code</code></li>
                <li><code>[link](url)</code> → clickable link</li>
                <li><code>[[Note]]</code> or <code>[[Note|display]]</code> → internal link</li>
            </ul>
            <p>Use the command palette to insert sidenotes quickly.</p>
        `;
	}
}
