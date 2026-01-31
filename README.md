# Sidenotes

I first discovered sidenotes, at least in a conscious way, on [Gwern.net](https://gwern.net/sidenote) which was referencing [Edward Tufte's conventions](https://edwardtufte.github.io/tufte-css/).

My goal is to have the same sidenotes work in both Obsidian and the web published version of my notes.

![Screenshot](https://github.com/cparsell/sidenotes/blob/main/Screenshot2.png)

### Features:

- **Sidenotes**: Create a sidenote using an HTML tag. Sidenotes then display in the margin of a note
- **They are editable in the margin**. Click on it, edit, and press enter.
- **Customize**:
    - Show sidenotes in left or right margin
    - Arabic numbers, Roman, letters, or no numbers
    - Customize spacing to tweak how it takes up space in the margin
    - Customize font size, line height, text alignment
    - **Superscript numbers** can be added to the text. The numbers increment automatically.
- **Links in sidenotes**: The plugin makes sure links in sidenotes appear as links.
- **Dynamic styling**: Font size shrinks as horizontal space get smaller. At a certain breakpoint, sidenotes hide when a window gets too skinny.
- Works in _Editing_ and _Reading_ modes

### Goal Features:

- **Optional Markdown style syntax:** I'd like an optional Markdown-style mode to enable some sort of coded sidenote like `;;sidenote text;;` or `&&sidenote text&&`. Currently, it only responds to this one HTML tag `<span class="sidenote">`. The benefit of HTML syntax is that it can be made to work in web-published notes as well.
- Add a command for `Create a new sidenote` so it can be hotkeyed.

## Alternatives:

These are some other strategies I've seen for sidenotes in Obsidian.

- [SideNote Plugin](https://github.com/mofukuru/SideNote) allows you to add comments to a piece of text, and this is viewable in the side panel.
- [crnkv/obsidian-sidenote-auto-adjust-module](https://github.com/crnkv/obsidian-sidenote-auto-adjust-module) ([forum post](https://forum.obsidian.md/t/css-snippet-sidenote-auto-adjust-module-four-styles-available/94495))
- [Collapsible Sidenotes using a CSS trick](https://forum.obsidian.md/t/meta-post-common-css-hacks/1978/341)
- [Sidenotes Using CSS also](https://scripter.co/sidenotes-using-only-css/)
- [A sidenote solution similar to Tufte CSS](https://www.kooslooijesteijn.net/blog/sidenotes-without-js)
- [Obsidian-sidenote-callout](https://github.com/xhuajin/obsidian-sidenote-callout/blob/main/README.md) - I did not use a custom callout like this because I wanted the sidenotes to also be publishable.
- [Tufte style sidenotes](https://medium.com/obsidian-observer/tufte-style-sidenotes-in-obsidian-89b0a785bc54)
- [Collapsible inline notes and sidenotes](https://forum.obsidian.md/t/collapsible-inline-notes-and-sidenotes/31909)

### AI disclaimer

Large Language Models (LLM) were used in the production and editing of this code. While I am comfortable with JavaScript programming, I still struggle to fully understand programming for Obsidian.

## Known issues

- ~~Numbers may not update immediately when sequencing changes. For example, if the first sidenote is removed, the second one becomes the first but may still be annotated 2. Reopening the note fixes it~~ (Fixed 1/30/26)

## Setup

1. Add the plugin to Obsidian. If copying manually from this repo, you can copy the contents of `/sidenotes-helper/` into `your-vault/.obsidian/plugins/sidenotes-helper`.
2. If copying manually, restart Obsidian and then enable the plugin in **Settings**.

## Use

Create a sidenote using this:

```html
This is a normal sentence.<span class="sidenote"
	>This is a sidenote. See [this link](http://example.com).</span
>
```

For now, I've set up a snippet that inserts the HTML template of the sidenote. There are Obsidian snippet plugins one could use for this.

I use [Raycast](https://www.raycast.com/) for MacOS where I've made this snippet:

```html
<span class="sidenote">{cursor}</span>
```

When I type the keyword `!sidenote` Raycast inserts the snippet.

## Web Publishing

I use [Digital Garden](https://github.com/oleeskild/Obsidian-Digital-Garden) to publish a subset of my notes to a website. In the framework Digital Garden has set up, a CSS file called `custom-styles.css` is where one adds any CSS to modify the default styles.

The snippet of CSS I've been using for web publishing is located in `/digital-garden/custom-styles.css`.
