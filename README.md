## Sidenote-helper

I first discovered sidenotes, at least in a conscious way, on [Gwern.net](https://gwern.net/sidenote). He was referencing Edward Tufte's conventions.

My goal is to have the same sidenotes work in both Obsidian and the web published version.

![Screenshot](https://github.com/cparsell/sidenotes/blob/main/Screenshot.png)

### Features:

- **Sidenotes**: Allows you to write sidenotes which show in the left side margin next to a note's main body
- Links in sidenotes: The plugin makes sure links in sidenotes appear as links.
- Superscript numbers are added to the text. .e.g. This text^1 and they will count sequentially
- Width of sidenotes changes dynamically based on the size of the editor
- Works in _Editing_ and _Reading_ modes

### Alternatives:
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

Large Language Models (LLM) were used in the production and editing of this code. While I am comfortable with JavaScript programming, I still struggle to fully understand programming for Obsidian so the robots helped a lot.

## Known issues

- Numbers may not update immediately. For example, if the first sidenote is removed, the second one becomes the first but may still be annotated 2. Reopening the note fixes it.

## Goals

- **Optional Markdown style syntax:** I'd like an optional Markdown-style mode to enable some sort of coded sidenote like `;;sidenote text;;` or `&&sidenote text&&`. Currently, it only responds to this one HTML tag `<span class="sidenote">`. The benefit of HTML syntax is that it can be made to work in web-published notes as well.

## Setup

1. Add the plugin to Obsidian. If copying manually from this repo, you can copy the contents of `/sidenotes-helper/` into `your-vault/.obsidian/plugins/sidenotes-helper`.
2. If copying manually, restart Obsidian and then enable the plugin in **Settings**.

## Use

Create a sidenote using this:

```html
Normal note text, not a sidenote<span class="sidenote">This is a sidenote. See [this link](http://example.com).</span>
```

I set up a snippet that inserts the basic bits so that I don't have to type all this HTML. There are Obsidian snippet plugins.

I use [Raycast](https://www.raycast.com/) for MacOS where I've made this snippet:

```html
<span class="sidenote">{cursor}</span>
```

When I type the keyword `!sidenote` Raycast inserts the snippet.

## Web Publishing

I use [Digital Garden](https://github.com/oleeskild/Obsidian-Digital-Garden) to publish a subset of my notes to a website. In the framework Digital Garden has set up, a CSS file called `custom-styles.css` is where one adds any CSS to modify the default styles.

The snippet of CSS I've been using for web publishing is located in `/digital-garden/custom-styles.css`.
