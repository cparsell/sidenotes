# Sidenotes

I first discovered sidenotes, in a conscious way, on [Gwern.net](https://gwern.net/sidenote) which was referencing [Edward Tufte's conventions](https://edwardtufte.github.io/tufte-css/).

My goal is to have the same sidenotes work in both Obsidian **and** the web published version of my notes.

![Sidenotes Basics](https://github.com/cparsell/sidenotes/blob/main/Screenshot2.png)
_Basic sidenote capabilities demonstrated_

![Neumorphic badges](https://github.com/cparsell/sidenotes/blob/main/Screenshot-badges-multi.png)
_An optional style that highlights references. Useful in long texts_

### Features:

- **Sidenotes**: Sidenotes are displayed in the margin of a note. Run command `Insert Sidenote` to start one.
  - **External and Internal link support**
  - **Supports basic Markdown formatting:** **Bold**, _italic_, and `inline code`
  - Sidenotes can be encoded using **footnotes** or an **HTML tag** `<span class="sidenote">`.
  - HTML Tag sidenotes work in _Editing_ and _Reading_ modes. When using footnotes, this currently only works in Reading Mode.

- **They are editable in the margin**. Click on it, edit, and press enter.
- **Dynamic styling**: Font size shrinks as horizontal space get smaller. At a certain breakpoint, sidenotes hide when a window gets too skinny.
- **Settings**:
  - Show sidenotes in left or right margin
  - Superscript numbers can be added to the text. The numbers increment automatically.
  - Number styled as Arabic numbers, Roman, letters, or no numbers
  - Customize spacing to tweak how it takes up space in the margin
  - Customize font size, line height, text alignment, and color

### Goal Features:

- **Optional Markdown style syntax:** I'd like an optional Markdown-style mode to enable some sort of coded sidenote like `;;sidenote text;;` or `&&sidenote text&&`. Currently, it only responds to this one HTML tag `<span class="sidenote">`. The benefit of HTML syntax is that it can be made to work in web-published notes as well.
- An option to convert footnotes into sidenotes in Reading Mode and in Editing Mode. Current only works in Reading Mode.

### Known issues

- ~~Footnotes, when converted to sidenotes, collide and/or are not positioned properly in the sidenote column.~~ (Tentatively fixed 2/3/26)
- ~~Sidenotes seem to collide with each other in certain circumstances. So far I just see it in Reading Mode.~~ (Fixed 2/2/26)
- ~~Numbers may not update immediately when sequencing changes. For example, if the first sidenote is removed, the second one becomes the first but may still be annotated 2. Reopening the note fixes it~~ (Fixed 1/30/26)
- ~~The cursor is brought to the top of the note after editing in the margin, if one edits/deletes the content in the note.~~ (Fixed 1/31/26)
- ~~When editing sidenotes in the margin, after pressing enter, the wrong sidenote may get updated if two sidenotes have the same text~~ (Fixed 1/31/26).
- ~~Also when editing sidenotes in the margins, especially lower down in a note, the numbers may reset. e.g. instead of being 5,6 and 7, they become 1, 2, and 3~~ (Fixed 1/31/26).

## Alternatives:

These are some other strategies I've seen for sidenotes in Obsidian.

- [FelixHT's Obsidian Sidenotes Plugin](https://github.com/FelixHT/obsidian_side_notes) - hasn't been updated in a while - one user reported it doesn't fully function any longer but I haven't tested it.
- [SideNote Plugin](https://github.com/mofukuru/SideNote) allows you to add comments to a piece of text, and this is viewable in the side panel.
- [crnkv/obsidian-sidenote-auto-adjust-module](https://github.com/crnkv/obsidian-sidenote-auto-adjust-module) ([forum post](https://forum.obsidian.md/t/css-snippet-sidenote-auto-adjust-module-four-styles-available/94495))
- [Collapsible Sidenotes using a CSS trick](https://forum.obsidian.md/t/meta-post-common-css-hacks/1978/341)
- [Sidenotes Using CSS also](https://scripter.co/sidenotes-using-only-css/)
- [A sidenote solution similar to Tufte CSS](https://www.kooslooijesteijn.net/blog/sidenotes-without-js)
- [Obsidian-sidenote-callout](https://github.com/xhuajin/obsidian-sidenote-callout/blob/main/README.md) - I did not use a custom callout like this because I wanted the sidenotes to also be publishable.
- [Tufte style sidenotes](https://medium.com/obsidian-observer/tufte-style-sidenotes-in-obsidian-89b0a785bc54)
- [Collapsible inline notes and sidenotes](https://forum.obsidian.md/t/collapsible-inline-notes-and-sidenotes/31909)

## Setup

1. Add the plugin to Obsidian. If copying manually from this repo, you can copy the contents of `/sidenotes-helper/` into `your-vault/.obsidian/plugins/sidenotes-helper`.
2. If copying manually, restart Obsidian and then enable the plugin in **Settings**.

## Use

Run the command `Insert Sidenote`. It will insert this:

```html
<span class="sidenote">{cursor}</span>
```

## Web Publishing

I use [Digital Garden](https://github.com/oleeskild/Obsidian-Digital-Garden) to publish a subset of my notes to a website. In the framework Digital Garden has set up, a CSS file called `custom-styles.css` is where one adds any CSS to modify the default styles.

The snippet of CSS I've been using for web publishing is located in `/digital-garden/custom-styles.css`.

## AI disclaimer

Large Language Models (LLM) were used in the production and editing of this code. I'll do my best not to keep it from being slop.
