## Sidenotes

I first discovered sidenotes, at least in a conscious way, on [Gwern.net](https://gwern.net/sidenote) which was referencing [Edward Tufte's conventions](https://edwardtufte.github.io/tufte-css/).

My goal is to have sidenotes work in **Obsidian** as well as my **notes published on the web**. More recently, I've started working on making it compatible with PDF export (still in progress)

![Sidenotes Basics](https://github.com/cparsell/sidenotes/blob/main/Screenshot2.png)
_Basic sidenote capabilities demonstrated_

![Neumorphic badges](https://github.com/cparsell/sidenotes/blob/main/Screenshot-badges-multi.png)
_An optional style that highlights references._

![Neumorphic badges](https://github.com/cparsell/sidenotes/blob/main/Screen-Record-Editing.gif)
_Editing a sidenote in the margin and then adding a new sidenote_

### Features

- **Sidenotes**: Sidenotes are displayed in the margin of an Obsidian note. Sidenotes show in _Editing_ and _Reading_ modes. It's possible to enable editing of sidenotes in Reading Mode.
  Run command `Insert Sidenote` to start one.
  - **External and Internal link support**
  - **Supports basic Markdown formatting:** **Bold**, _italic_, and `inline code`
  - Sidenotes can be configured to work one of two ways:
    - **Markdown footnotes**: `This is a sentence[^1].`
    - **an HTML tag**: `<span class="sidenote">`.
  - **Margin Notes**: Non-numbered notes displayed in the margin. In Editing Mode, it will display a **※** symbol in the main text where the margin note is "placed".
    - **Markdown footnotes**: Written as `[^mn-1]` or `[^mn-kitchen]`
    - **HTML**: Written as `<span class="sidenote margin-note">`.

- **They are editable in the margin**. Click on it, edit, and press enter.
- **Dynamic styling**: Font size shrinks as horizontal space get smaller. At a certain breakpoint, sidenotes hide when a window gets too skinny.
- **PDF Export**: This currently only works with HTML sidenotes. Footnotes are more complicated and will take time to (hopefully) figure that out
- **Settings**:
  - Show sidenotes in left or right margin
  - Superscript numbers can be added to the text. The numbers increment automatically.
  - Numbers displayed as Arabic numbers, Roman letters, or no numbers
  - Numbers styled as plain or with badges to highlight them a bit
  - Customize spacing to tweak how it takes up space in the margin
  - Customize font size, line height, text alignment, and color

### Goal Features

- [ ] Command: Re-sequence footnote numbers. They have a habit of getting out of order once you insert new ones.
- [x] Option to have non-numbered sidenotes - aka "margin notes" ✅ 2026-02-26
- [ ] Optional background color to sidenotes
- [ ] Option for Sidenotes on both left and right margins (may only work with HTML, seems unlikely to allow coding like this with Markdown footnotes)
- [ ] Option for style templates for multiple sidenotes types - e.g. one type has a background color, another does not.
- [ ] Highlight the referencing _sentence_ in the main note text when hovering over a sidenote
- [ ] Possible feature: Footnote-Sidenote switch command

## Alternatives and inspirations

- [FelixHT's Obsidian Sidenotes Plugin](https://github.com/FelixHT/obsidian_side_notes) - hasn't been updated in a while - one user reported it doesn't fully function any longer but I haven't tested it. I did build some of the functionality in my plugin based on this.
- [SideNote Plugin](https://github.com/mofukuru/SideNote) allows you to add comments to a piece of text, and this is viewable in the side panel.
- [crnkv/obsidian-sidenote-auto-adjust-module](https://github.com/crnkv/obsidian-sidenote-auto-adjust-module) ([forum post](https://forum.obsidian.md/t/css-snippet-sidenote-auto-adjust-module-four-styles-available/94495))
- [Collapsible Sidenotes using a CSS trick](https://forum.obsidian.md/t/meta-post-common-css-hacks/1978/341)
- [Sidenotes Using CSS also](https://scripter.co/sidenotes-using-only-css/)
- [A sidenote solution similar to Tufte CSS](https://www.kooslooijesteijn.net/blog/sidenotes-without-js)
- [Obsidian-sidenote-callout](https://github.com/xhuajin/obsidian-sidenote-callout/blob/main/README.md) - I did not use a custom callout like this because I wanted the sidenotes to also be publishable.
- [Tufte style sidenotes](https://medium.com/obsidian-observer/tufte-style-sidenotes-in-obsidian-89b0a785bc54)
- [Collapsible inline notes and sidenotes](https://forum.obsidian.md/t/collapsible-inline-notes-and-sidenotes/31909)

## Setup

1. Add the plugin to Obsidian. If copying manually from this repo, you can copy the contents of `/sidenotes/` into `your-vault/.obsidian/plugins/sidenotes`.
2. If copying manually, restart Obsidian and then enable the plugin in **Settings**.
3. **Configure the settings** how you like:
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

### **If using footnotes**

it will insert `[^1]` and create a sidenote for you to enter text in.

## Web Publishing

I use [Digital Garden](https://github.com/oleeskild/Obsidian-Digital-Garden) to publish a subset of my notes to a website. In the framework Digital Garden has set up, a CSS file called `custom-styles.css` is where one adds any CSS to modify the default styles.

The snippet of CSS I've been using for web publishing is located in `/digital-garden/custom-styles.css`.

### Known issues

- HTML sidenotes, in Reading Mode? - When pressing enter to update the last sidenote, it jumps up about 1 page
- Changing style settings causes Editing mode sidenotes to disappear until restart
- ~~Footnotes, Reading Mode - Editing mode box will overlap over a sidenote just below it~~
- ~~Footnotes, when converted to sidenotes, collide and/or are not positioned properly in the sidenote column.~~ (Tentatively fixed 2/3/26)
- ~~Sidenotes seem to collide with each other in certain circumstances. So far I just see it in Reading Mode.~~ (Fixed 2/2/26)
- ~~Numbers may not update immediately when sequencing changes. For example, if the first sidenote is removed, the second one becomes the first but may still be annotated 2. Reopening the note fixes it~~ (Fixed 1/30/26)
- ~~The cursor is brought to the top of the note after editing in the margin, if one edits/deletes the content in the note.~~ (Fixed 1/31/26)
- ~~When editing sidenotes in the margin, after pressing enter, the wrong sidenote may get updated if two sidenotes have the same text~~ (Fixed 1/31/26).
- ~~Also when editing sidenotes in the margins, especially lower down in a note, the numbers may reset. e.g. instead of being 5,6 and 7, they become 1, 2, and 3~~ (Fixed 1/31/26).

## AI disclaimer

Large Language Models (LLM) were used in the production and editing of this code. I'll do my best not to keep it from being slop.
