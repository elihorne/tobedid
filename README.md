# to be did

*What did you do today? I did it.*

A floating card for Obsidian that turns today's to-be-done into did. One card per day, a handful of lines, and four marks: new, in progress, done, carried over. It stays on screen while you move between notes, and it minimizes to a pill showing whatever is in progress.

The point is a short list you actually commit to today. It is not a task database. Longer-running work belongs somewhere else, and the card holds today's slice of it.

## Using it

- **Click a mark** to go from new to in progress to done. **Right-click a row** for every state, **carry over** to the next workday, open its linked note, or edit the line.
- **Type in the dashed line** and press Enter. **Shift+Enter** adds a link to the note you have open, so the item can take you back to its context.
- **Moving between days:** click the title to flip between today and the next workday, where carried items land. The ‹ › arrows step back one day at a time and forward as far as tomorrow, never further, since anything beyond that belongs on a longer list, and clicking the title from any other day brings you back to today. Minimizing always returns to today. Commands for today, previous day and next day can take hotkeys.
- **Someday** (optional): set a note with a longer list of checkboxes in settings, and › past tomorrow shows it. It is a window onto that list, not a copy: dated items first, soonest due at the top, then in-progress, then the rest. Right-click to **Do today** or **Do tomorrow**, which puts a short headline on that card with a link back. Marks clicked here change the list itself. Lines containing words you choose are hidden, since the card floats over screen shares. The list ends at a heading you name, by default Retired, Archive or Done.
- **Asking about an item:** Option-click an item (on a card or in Someday) to drop a short reference to it into your chat panel's input, without sending, so you can type the question after it. Right-click has **Ask** and **Copy reference**. The reference names the item, its state, the file and line, and its linked note, which is enough for an agent to find it.
- **Drag the header** to move it. The minus button shrinks it to a pill, and the pill grows upward when you open it. Right-click the header to open the card as a note, bring items forward, reset its position or hide it.
- **Starting a new day:** if the last card has unfinished items, a "Bring forward" link moves them over and marks them carried on the old card.
- Commands: show or hide, minimize, add an item, bring forward, open today's card. All can take a hotkey.
- **Clearing the card:** when the last committed line is done, the card marks the moment once, with a brief glow, the marks popping in turn, a small burst from the dot you clicked, and "Did it." Carried items don't count against you. Reloading never replays it, and reduced-motion settings get the state without the animation.

## The file format (the contract)

Every card is a plain markdown note at `<folder>/YYYY-MM-DD.md`. Anything that can write markdown can write a card, whether that's a person, a template, a script or an agent. The plugin picks up changes made outside it.

```markdown
---
type: card
date: 2026-11-09
committed: 5
done: 2
in_progress: 1
open: 2
carried: 0
progress: 0.4
---

- [x] Reply to the venue about the room → [[Team offsite]]
- [/] Draft the launch outline → [[Launch plan]]
- [ ] Review the pull request
- [>] Book the dentist
```

| Mark | State | Meaning |
|---|---|---|
| `[ ]` | new | Committed to today, not started |
| `[/]` | in progress | Started |
| `[x]` | done | Finished |
| `[>]` | carried | Moved to a later card, where it appears again |

- **Only top-level `- [?] ` lines are items.** Anything else in the file (headings, prose, nested bullets) is left alone and not shown.
- **A trailing `→ [[note]]` is the item's link.** The card shows the text before it and opens the note on click. A link in the middle of a sentence also works, and its label is shown inline.
- **The frontmatter counts are written by the plugin**, so Bases, Dataview and agents can read progress without parsing the list. `committed` excludes carried items, and `progress` is `done / committed`. They are recomputed whenever the file changes, whoever changed it. You can turn this off in settings.

## Someday conventions

Someday reads any note of checkboxes. It understands:

- **Due dates** from the Tasks plugin (`📅 2026-11-12`, also `📅 Thu 2026-11-12`) and Dataview (`[due:: 2026-11-12]`). Undated items still show, after dated and in-progress ones.
- **Headlines.** A line that opens with a **bold sentence** shows just that sentence. Otherwise it shows the text before any Tasks metadata, without inline fields or #tags.
- **States.** Only open (`[ ]`) and in-progress (`[/]`) lines show. Marks changed on the card are written back to the line.

## For other plugins and agents

Inside Obsidian, the plugin exposes a small API:

```js
const card = app.plugins.plugins['tobedid'].api;

await card.items();                       // today's items: { line, ch, state, text, label, target }
await card.items('2026-11-06');           // any day
await card.stats();                       // { committed, done, in_progress, open, carried, progress }
await card.add('Send the recap → [[Weekly sync]]');               // 'added' | 'full' | 'duplicate'
await card.add('Finish the deck', { state: 'progress', date: '2026-11-10', force: true });
await card.setState('Send the recap → [[Weekly sync]]', 'done');  // matches on the exact line text
card.path();                              // today's card path
await card.someday();                     // the Someday list as shown: { line, ch, state, text, headline, due, link }
```

To receive item references in your own plugin, register a target. It appears in the settings dropdown:

```js
const off = card.registerSendTarget({
  id: 'my-chat',
  name: 'My chat',
  available: () => true,
  send: async (text) => { myChat.insert(text); return true; },   // return false to fall back to the clipboard
});
```

It also fires workspace events: `tobedid:changed` whenever a card's counts change, and `tobedid:cleared` once when today's card is finished, both with `{ date, path, ...stats }`, and `tobedid:send` with `{ text, target }` whenever an item is sent.

**Outside Obsidian,** read and write the files directly. That is the intended path for agents and scripts that work on the vault from disk. Be polite to the person using it: add lines, but leave their marks alone unless they asked you to change them.

## Settings

- **Cards folder.** Default `daily/cards`.
- **Lines on a card.** Default 10. New items stop at this number. Carried items can still land, so nothing is lost.
- **Skip weekends when carrying over.** Default on, so Friday carries to Monday.
- **Send items to.** Auto by default: the first installed target, falling back to the clipboard. Claudian is built in.
- **Write progress to frontmatter.** Default on.
- **Someday list.** A note path. Empty by default, which stops navigation at tomorrow.
- **Hide from Someday.** Comma-separated words. Empty by default.
- **Stop Someday at headings.** Default `Retired, Archive, Done`.

## Install

**With BRAT** (until it's in the community plugin directory): install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, choose *Add beta plugin*, and paste `elihorne/tobedid`.

**By hand:** download `manifest.json`, `main.js` and `styles.css` from the [latest release](https://github.com/elihorne/tobedid/releases/latest) into `<vault>/.obsidian/plugins/tobedid/`, reload Obsidian, and enable **to be did** under Community plugins.

Desktop only. There is no build step and there are no dependencies: `main.js` is the source.

## Roadmap

The plugin comes first. The website for [tobedid.com](https://tobedid.com) lives in [`site/`](site/): plain HTML, CSS and a little JavaScript with no build step, served by Cloudflare Pages. Sync may come later. Because a card is plain markdown, anything built later reads and writes the same files.

## Credit

[tobedid.com](https://tobedid.com)


The one-card-a-day practice and its marks were inspired by Ugmonk's Analog system, a paper product. This plugin is an independent project, not affiliated with or endorsed by Ugmonk.
