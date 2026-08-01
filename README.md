# Side-Notes

I first discovered sidenotes, at least in a conscious way, on [Gwern.net](https://gwern.net/sidenote) which was referencing [Edward Tufte's conventions](https://edwardtufte.github.io/tufte-css/).

![Sidenotes Basics](https://github.com/cparsell/sidenotes/blob/main/gh_assets/Screenshot2.png)
_Basic sidenote capabilities demonstrated_

![Neumorphic badges](https://github.com/cparsell/sidenotes/blob/main/gh_assets/Screenshot-badges-multi.png)
_An optional style that highlights references._

![Editing sidenotes](https://github.com/cparsell/sidenotes/blob/main/gh_assets/Screen-Record-Editing2.gif)
_Editing a sidenote in the margin, adding a new sidenote, then adding a new margin note_

## Features

### Sidenotes

Numbered notes displayed in the margin instead of at the bottom of the note. Run the `Insert sidenote` command to start one.

- **Two formats**, chosen in settings:
  - **HTML spans**: `<span class="sidenote">text</span>` — I use these because it was simple to make them work in my web-published notes too.
  - **Markdown footnotes**: `This is a sentence[^1].`
- **Visible in Editing and Reading modes.** Source mode is left alone: it shows the bare markdown.
- **Editable in the margin.** Click a sidenote, edit it, and press `ENTER` to save; `SHIFT+ENTER` adds a new line (HTML format only — Markdown footnote definitions are single-line). Editing in Reading mode is optional and off by default.
- **Supports internal and external links**, plus basic Markdown formatting: **bold**, _italic_, and `inline code`.

### Margin notes

Un-numbered notes in the margin, for asides that don't need a reference number. In Editing mode a small marker shows where the note is anchored; it can also be configured to open as a popup instead. Click to edit.

- **Markdown footnotes**: `[^mn-1]` or `[^mn-kitchen]`
- **HTML**: `<span class="sidenote margin-note">`

### Numbering

- Superscript reference numbers are added to the text and increment automatically.
- Displayed as Arabic numerals, Roman numerals, letters, or hidden entirely.
- Styled plain or as badges (including a neumorphic style) to make references easier to spot.
- Optionally restart numbering at each heading.

### Responsive layout

- Sidenotes sit in the left or right margin, anchored to the referencing line.
- Font size shrinks as horizontal space gets tighter; below configurable breakpoints the margin switches to a compact layout and then hides entirely.
- Collision avoidance keeps notes from overlapping when several land close together.
- Width, gaps, and page offset are all adjustable, as are font size, line height, text alignment, and colors.

### PDF export

Works with both HTML sidenotes and footnotes (experimental). Notes are laid out in the margin rather than inline, and margin notes are dropped from the endnote list at the end of the document.

## Goal Features

- [ ] Optional background color to sidenotes
- [x] Command: Re-sequence footnote numbers. They have a habit of getting out of order once you insert new ones. ✅ 2026-02-27
- [x] Option to have non-numbered sidenotes - aka "margin notes" ✅ 2026-02-26
- [x] Add scaling option for margin note icon in text and in margin ✅ 2026-03-02
- [x] Option for hidden margin notes: ✅ 2026-03-02

## Maybe Features

- [ ] Badge style for margin notes
- [ ] Option for Sidenotes on both left and right margins (may only work with HTML, seems unlikely to allow coding like this with Markdown footnotes)
- [ ] Option for style templates for multiple sidenotes types - e.g. one type has a background color, another does not. This seems more easily implemented if using HTML sidenotes.
- [ ] Highlight the referencing _sentence_ in the main note text when hovering over a sidenote
- [ ] Command: Switch between Footnotes visible <-> Sidenotes visible

## Alternatives and inspirations

- [FelixHT's Obsidian Sidenotes Plugin](https://github.com/FelixHT/obsidian_side_notes) - hasn't been updated in a while - one user reported it doesn't fully function any longer but I haven't tested it. I did build some of the functionality in my plugin based on this.
- [SideNote Plugin](https://github.com/mofukuru/SideNote) allows you to add comments to a piece of text, and this is viewable in the side panel.
- [Cornell Notes Learning Vault](https://github.com/TfTHacker/cornell-notes-learning-vault) from TfTHacker
- [crnkv/obsidian-sidenote-auto-adjust-module](https://github.com/crnkv/obsidian-sidenote-auto-adjust-module) ([forum post](https://forum.obsidian.md/t/css-snippet-sidenote-auto-adjust-module-four-styles-available/94495))
- [Collapsible Sidenotes using a CSS trick](https://forum.obsidian.md/t/meta-post-common-css-hacks/1978/341)
- [Sidenotes Using CSS also](https://scripter.co/sidenotes-using-only-css/)
- [A sidenote solution similar to Tufte CSS](https://www.kooslooijesteijn.net/blog/sidenotes-without-js)
- [Obsidian-sidenote-callout](https://github.com/xhuajin/obsidian-sidenote-callout/blob/main/README.md) - I did not use a custom callout like this because I wanted the sidenotes to also be publishable.
- [Tufte style sidenotes](https://medium.com/obsidian-observer/tufte-style-sidenotes-in-obsidian-89b0a785bc54)
- [Collapsible inline notes and sidenotes](https://forum.obsidian.md/t/collapsible-inline-notes-and-sidenotes/31909)

## Setup

1. If copying manually from this repo, download the plugin from [the Releases page](https://github.com/cparsell/sidenotes/releases).
2. Add the plugin files to your Obsidian vault.
   Copy the contents into `YOUR-VAULT/.obsidian/plugins/sidenotes`.
3. If copying manually, restart Obsidian and then enable the plugin in **Settings**.
4. **Configure the settings** how you like:
   - Choose **sidenote format**:
     - **Footnotes**: Traditional Markdown footnotes will become sidenotes
       - **Hide footnotes:** Choose if you want to hide the origina footnotes at the bottom of the note
       - **Hide footnote numbers:** Hide the original Markdown reference numbers in the note text - e.g. this: `[1]`
     - **HTML**: uses `<span>` elements to format the sidenotes. I originally designed using this because it was an easy way for me to set up CSS styles in Obsidian as well as CSS styles in my web-published notes
   - **Number style**: Try 'neumorphic badge' for numbers that are more visually identifiable
   - **Width & Spacing**:
     - Minimum sidenote width
     - Maximum sidenote width
     - Minimum gap between sidenote and text
     - Minimum gap between sidenote and editor edge
   - **Page offset factor**: Make some room for the sidenotes if you want. This shifts the note text over (only affects notes that have sidenotes)

## Use

Run the command `Insert Sidenote`.

### **If using HTML**

It will insert this:

```html
<span class="sidenote">{cursor}</span>
```

Click on the sidenote to edit it in the margin. Press `ENTER` to update. Press `SHIFT+ENTER` to add a new line in the sidenote.

### **If using footnotes**

it will insert `[^1]` and add a footnote at the bottom of the document. Press `ENTER` to update. Using `SHIFT+ENTER` will not work to add a new line in a footnote because of how footnotes are formatted in Markdown.

## Web Publishing

I use [Digital Garden](https://github.com/oleeskild/Obsidian-Digital-Garden) to publish a subset of my notes to a website. In the framework Digital Garden has set up, a CSS file called `custom-styles.css` is where one adds any CSS to modify the default styles.

The snippet of CSS I've been using for web publishing is located in `/digital-garden/custom-styles.css`.

### Known issues

- [x] PDF export doubles sidenote text ✅ 2026-07-29
- [x] Font size gets larger if sidenote is added to a header ✅ 2026-07-28
- [x] Footnotes sometimes still overlap. Sometimes they fix themselves but sometimes it sticks for a while ✅ 2026-07-28
- [ ] HTML sidenotes, in Reading Mode? - When pressing enter to update the last sidenote, it jumps up about 1 page
- [ ] Changing style settings causes Editing mode sidenotes to disappear until restart
- [x] Footnotes, Reading Mode - Editing mode box will overlap over a sidenote just below it
- [x] Footnotes, when converted to sidenotes, collide and/or are not positioned properly in the sidenote column.~~ (Tentatively fixed) ✅ 2026-02-03
- [x] Sidenotes seem to collide with each other in certain circumstances. So far I just see it in Reading Mode. (Fixed 2/2/26) ✅ 2026-02-02
- [x] Numbers may not update immediately when sequencing changes. For example, if the first sidenote is removed, the second one becomes the first but may still be annotated 2. Reopening the note fixes it (Fixed 1/30/26) ✅ 2026-01-30
- [x] The cursor is brought to the top of the note after editing in the margin, if one edits/deletes the content in the note. (Fixed 1/31/26) ✅ 2026-01-31
- [x] When editing sidenotes in the margin, after pressing enter, the wrong sidenote may get updated if two sidenotes have the same text (Fixed 1/31/26). ✅ 2026-01-31
- [x] Also when editing sidenotes in the margins, especially lower down in a note, the numbers may reset. e.g. instead of being 5,6 and 7, they become 1, 2, and 3 ✅ 2026-01-31

## Support

<a href="https://buymeacoffee.com/netsurgem"><img src="https://github.com/cparsell/sidenotes/blob/main/gh_assets/bmc-button.png?raw=true" width="150"></a>
