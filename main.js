'use strict';
// to be did: a floating card of what you commit to today, and the moment it becomes what you did.
// Each day is a plain markdown file of checkboxes: [ ] new, [/] in progress, [x] done, [>] carried over.
const { Plugin, PluginSettingTab, Setting, TFile, TFolder, Menu, Notice, normalizePath, moment, setIcon, debounce, parseYaml } = require('obsidian');

const STATE = { ' ': 'new', '/': 'progress', 'x': 'done', '>': 'carried' };
const LABEL = { ' ': 'New', '/': 'In progress', 'x': 'Done', '>': 'Carried over' };
const NEXT = { ' ': '/', '/': 'x', 'x': ' ' };
const TASK_RE = /^- \[(.)\] (.*)$/;
const LINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
const TRAILING_LINK_RE = /^(.*?)\s*(?:→|->|·|—)?\s*\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]\s*$/;

const SOMEDAY = 'someday';
const DEFAULTS = { folder: 'daily/cards', maxItems: 10, skipWeekends: true, writeStats: true, somedaySource: '', somedayHide: '', somedayStop: 'Retired, Archive, Done', sendTo: 'auto', right: null, bottom: null, collapsed: false, visible: true };

// Counts written to each card's frontmatter, so Bases, Dataview and agents can read progress without parsing.
function stats(items) {
	const c = { new: 0, progress: 0, done: 0, carried: 0 };
	for (const i of items) c[STATE[i.ch] || 'new']++;
	const committed = items.length - c.carried;
	return { committed, done: c.done, in_progress: c.progress, open: c.new, carried: c.carried, progress: committed ? Math.round((c.done / committed) * 100) / 100 : 0 };
}

function parse(data) {
	const items = [];
	data.split('\n').forEach((line, i) => {
		const m = TASK_RE.exec(line);
		if (m) items.push({ line: i, ch: m[1] === 'X' ? 'x' : m[1], text: m[2] });
	});
	return items;
}

function linkLabel(target, alias) {
	return alias || target.split('#')[0].split('/').pop();
}

// Turn a task line into what the card shows: plain text plus the first linked note.
function display(text) {
	let target = null;
	let body = text;
	const trailing = TRAILING_LINK_RE.exec(text);
	if (trailing && trailing[1].trim()) {
		target = trailing[2];
		body = trailing[1];
	}
	body = body.replace(LINK_RE, (_, t, alias) => {
		if (!target) target = t;
		return linkLabel(t, alias);
	});
	body = body.replace(/\*\*|==|__/g, '').trim();
	return { label: body, target };
}

// Suggestions live in the card's frontmatter so anything that writes markdown can propose lines:
//   suggestions:
//     - Reply to the venue
//     - { text: Draft the outline → [[Launch plan]], source: claude }
// They are not items: they don't count until someone keeps one.
function readSuggestions(data) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(data);
	if (!m) return [];
	let fm;
	try { fm = parseYaml(m[1]) || {}; } catch (e) { return []; }
	const raw = Array.isArray(fm.suggestions) ? fm.suggestions : [];
	return raw
		.map((s) => (typeof s === 'string' ? { text: s } : s && typeof s.text === 'string' ? { text: s.text, source: s.source } : null))
		.filter((s) => s && s.text.trim());
}

// Task metadata emoji from the Tasks plugin: due, scheduled, start, done, created, priorities, recurrence, id, depends.
const TASKS_META_RE = /[📅⏳🛫✅➕⏫🔼🔽⏬🔺🔁🆔⛔❌]/u;

// Due date in the common conventions: Tasks (📅 2026-11-09, also 📅 Mon 2026-11-09) and Dataview ([due:: 2026-11-09]).
function dueDate(text) {
	const m = /📅\uFE0F?[^\d\n]{0,12}(\d{4}-\d{2}-\d{2})/u.exec(text) || /\bdue::\s*(\d{4}-\d{2}-\d{2})/i.exec(text);
	return m ? m[1] : null;
}

// A short headline for a longer list's line: its bold lead if it has one, otherwise the text before any task metadata.
function headline(text) {
	const bold = /^\*\*(.+?)\*\*/.exec(text);
	let h = text;
	if (bold) h = bold[1];
	else {
		const cut = TASKS_META_RE.exec(h);
		if (cut && cut.index > 0) h = h.slice(0, cut.index);
		h = h.replace(/\[[\w-]+::[^\]]*\]/g, '').replace(/(^|\s)#[\w/-]+/g, '$1');
	}
	h = h.replace(LINK_RE, (_, t, alias) => linkLabel(t, alias));
	h = h.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '');
	h = h.replace(/^\s*(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Today)\s+)?(?:\d{4}-)?\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?\s*[—–:-]\s*/, '');
	h = h.replace(/\*\*|==|__|`/g, '').replace(/\s+/g, ' ').trim().replace(/[.:]$/, '');
	return h.charAt(0).toUpperCase() + h.slice(1);
}

module.exports = class Tobedid extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());
		this.renderToken = 0;
		this.buildPanel();
		this.addSettingTab(new TobedidSettings(this.app, this));
		this.sendTargets = new Map();
		this.registerBuiltInTargets();
		this.api = this.buildApi();

		this.addRibbonIcon('square-check', 'to be did', () => this.setVisible(!this.settings.visible));
		this.addCommand({ id: 'toggle', name: 'Show or hide the card', callback: () => this.setVisible(!this.settings.visible) });
		this.addCommand({ id: 'minimize', name: 'Minimize or expand the card', callback: () => { this.setVisible(true); this.setCollapsed(!this.settings.collapsed); } });
		this.addCommand({ id: 'add', name: 'Add an item', callback: () => this.focusInput() });
		this.addCommand({ id: 'bring-forward', name: 'Bring forward unfinished items from the last card', callback: () => this.bringForward() });
		this.addCommand({ id: 'open', name: 'Open the card as a note', callback: () => this.openCard() });
		this.addCommand({ id: 'go-today', name: 'Go to today', callback: () => this.goTo(null) });
		this.addCommand({ id: 'previous-day', name: 'Previous day', callback: () => this.shiftDay(-1) });
		this.addCommand({ id: 'next-day', name: 'Next day', callback: () => this.shiftDay(1) });

		const rerender = debounce(() => this.render(), 150, true);
		const inFolder = (f) => f && f.path.startsWith(normalizePath(this.settings.folder) + '/');
		this.registerEvent(this.app.vault.on('modify', (f) => (inFolder(f) || (this.viewDate === SOMEDAY && f.path === normalizePath(this.settings.somedaySource))) && rerender()));
		this.registerEvent(this.app.vault.on('create', (f) => inFolder(f) && rerender()));
		this.registerEvent(this.app.vault.on('delete', (f) => inFolder(f) && rerender()));
		this.registerEvent(this.app.vault.on('rename', (f, old) => (inFolder(f) || old.startsWith(this.settings.folder)) && rerender()));
		// Keep the frontmatter counts true however the card was edited: panel, editor, sync or an agent.
		this.registerEvent(this.app.metadataCache.on('changed', (f, data, cache) => inFolder(f) && this.syncStats(f, data, cache)));
		this.registerDomEvent(window, 'resize', () => this.applyPosition());
		// Roll over to the new day's card without a reload.
		this.registerInterval(window.setInterval(() => { if (!this.viewDate && this.shownDate !== this.today()) this.render(); }, 60 * 1000));

		this.app.workspace.onLayoutReady(async () => {
			this.render();
			// Backfill counts on cards written before this version, or while the plugin was off.
			const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.folder));
			if (!(folder instanceof TFolder)) return;
			for (const f of folder.children) {
				if (f instanceof TFile && f.extension === 'md') await this.syncStats(f, await this.app.vault.read(f), this.app.metadataCache.getFileCache(f));
			}
		});
	}

	onunload() {
		if (this.panel) this.panel.remove();
	}

	save() {
		return this.saveData(this.settings);
	}

	// ---------- dates and files ----------

	today() {
		return moment().format('YYYY-MM-DD');
	}

	nextWorkday(date) {
		const d = moment(date, 'YYYY-MM-DD').add(1, 'day');
		while (this.settings.skipWeekends && (d.day() === 0 || d.day() === 6)) d.add(1, 'day');
		return d.format('YYYY-MM-DD');
	}

	cardPath(date) {
		return normalizePath(`${this.settings.folder}/${date}.md`);
	}

	async ensureCard(date) {
		const path = this.cardPath(date);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		const folder = normalizePath(this.settings.folder);
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			try { await this.app.vault.createFolder(folder); } catch (e) { /* created concurrently */ }
		}
		return this.app.vault.create(path, `---\ntype: card\ndate: ${date}\n---\n\n`);
	}

	previousCard(date) {
		const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.folder));
		if (!(folder instanceof TFolder)) return null;
		const cards = folder.children
			.filter((f) => f instanceof TFile && /^\d{4}-\d{2}-\d{2}$/.test(f.basename) && f.basename < date)
			.sort((a, b) => b.basename.localeCompare(a.basename));
		return cards[0] || null;
	}

	async pending(file) {
		return parse(await this.app.vault.read(file)).filter((i) => i.ch === ' ' || i.ch === '/');
	}

	async syncStats(file, data, cache) {
		if (!this.settings.writeStats || !/^\d{4}-\d{2}-\d{2}$/.test(file.basename)) return;
		const next = stats(parse(data));
		const fm = (cache && cache.frontmatter) || {};
		if (Object.keys(next).every((k) => fm[k] === next[k])) return;
		await this.app.fileManager.processFrontMatter(file, (f) => Object.assign(f, next));
		this.app.workspace.trigger('tobedid:changed', { date: file.basename, path: file.path, ...next });
	}

	// Public surface for other plugins and agents running inside Obsidian:
	//   app.plugins.plugins['tobedid'].api
	buildApi() {
		const self = this;
		return {
			version: 1,
			path: (date = self.today()) => self.cardPath(date),
			today: () => self.today(),
			async items(date = self.today()) {
				const f = self.app.vault.getAbstractFileByPath(self.cardPath(date));
				if (!(f instanceof TFile)) return [];
				return parse(await self.app.vault.read(f)).map((i) => ({ ...i, state: STATE[i.ch] || 'new', ...display(i.text) }));
			},
			async stats(date = self.today()) { return stats(await this.items(date)); },
			add: (text, { date = self.today(), state = 'new', force = false } = {}) => {
				const ch = Object.keys(STATE).find((k) => STATE[k] === state) || ' ';
				return self.appendItem(date, text, ch, force);
			},
			async setState(text, state, date = self.today()) {
				const item = (await this.items(date)).find((i) => i.text === text);
				const ch = Object.keys(STATE).find((k) => STATE[k] === state);
				if (!item || ch == null) return false;
				await self.setState(item, ch, date);
				return true;
			},
			bringForward: () => self.bringForward(),
			// Let another plugin receive item references: { id, name, available: () => bool, send: async (text) => bool }
			registerSendTarget: (target) => { self.sendTargets.set(target.id, target); return () => self.sendTargets.delete(target.id); },
			someday: async () => (await self.somedayItems()).items,
			// Propose lines without committing to them. Each is a string; source names who suggested it.
			suggest: (texts, { date = self.today(), source } = {}) => self.addSuggestions(date, [].concat(texts), source),
			async suggestions(date = self.today()) {
				const f = self.app.vault.getAbstractFileByPath(self.cardPath(date));
				return f instanceof TFile ? readSuggestions(await self.app.vault.read(f)) : [];
			},
			acceptSuggestion: (text, date = self.today()) => self.acceptSuggestion(date, text),
			dismissSuggestion: (text, date = self.today()) => self.removeSuggestion(date, text),
			show: () => self.setVisible(true),
		};
	}

	// ---------- writes ----------

	async appendItem(date, text, ch = ' ', force = false) {
		const file = await this.ensureCard(date);
		let result = 'added';
		await this.app.vault.process(file, (data) => {
			const items = parse(data);
			if (items.some((i) => i.text === text && i.ch !== '>')) { result = 'duplicate'; return data; }
			if (!force && items.length >= this.settings.maxItems) { result = 'full'; return data; }
			const base = data.endsWith('\n') ? data : data + '\n';
			return `${base}- [${ch}] ${text}\n`;
		});
		return result;
	}

	async setState(item, ch, date = this.shownDate) {
		const file = this.app.vault.getAbstractFileByPath(this.cardPath(date));
		if (!(file instanceof TFile)) return;
		await this.app.vault.process(file, (data) => {
			const lines = data.split('\n');
			const m = TASK_RE.exec(lines[item.line] || '');
			if (!m || m[2] !== item.text) {
				new Notice('The card changed underneath. Try again.');
				return data;
			}
			lines[item.line] = `- [${ch}] ${m[2]}`;
			return lines.join('\n');
		});
	}

	async carry(item) {
		const to = this.nextWorkday(this.shownDate);
		await this.appendItem(to, item.text, item.ch === '/' ? '/' : ' ', true);
		await this.setState(item, '>');
		new Notice(`Carried to ${moment(to, 'YYYY-MM-DD').format('ddd D MMM')}`);
	}

	async bringForward() {
		const today = this.today();
		const prev = this.previousCard(today);
		if (!prev) { new Notice('No earlier card.'); return; }
		const items = await this.pending(prev);
		if (!items.length) { new Notice('Nothing left on the last card.'); return; }
		for (const it of items) await this.appendItem(today, it.text, it.ch, true);
		await this.app.vault.process(prev, (data) => {
			const lines = data.split('\n');
			for (const it of items) {
				const m = TASK_RE.exec(lines[it.line] || '');
				if (m && m[2] === it.text) lines[it.line] = `- [>] ${it.text}`;
			}
			return lines.join('\n');
		});
	}

	async addFromInput(text, linkActive) {
		const date = this.shownDate || this.today();
		const active = this.app.workspace.getActiveFile();
		if (linkActive && active && !active.path.startsWith(normalizePath(this.settings.folder) + '/')) {
			text += ' → ' + this.app.fileManager.generateMarkdownLink(active, this.cardPath(date));
		}
		const result = await this.appendItem(date, text);
		if (result === 'full') new Notice(`The card holds ${this.settings.maxItems}. Finish or carry something first.`);
		if (result === 'duplicate') new Notice('Already on the card.');
		return result === 'added';
	}

	async openCard(line) {
		if (this.shownDate === SOMEDAY) { const src = this.somedaySource(); if (src) await this.openAt(src, line || 0); return; }
		const file = await this.ensureCard(this.shownDate || this.today());
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file, line != null ? { eState: { line } } : {});
	}

	openLink(target, e) {
		this.app.workspace.openLinkText(target, this.cardPath(this.shownDate), !!(e && (e.metaKey || e.ctrlKey)));
	}

	// ---------- panel ----------

	buildPanel() {
		const el = (this.panel = document.body.createDiv({ cls: 'tobedid' }));
		this.head = el.createDiv({ cls: 'ac-head' });
		this.titleEl = this.head.createDiv({ cls: 'ac-title' });
		const nav = this.head.createDiv({ cls: 'ac-nav' });
		const prevBtn = nav.createDiv({ cls: 'ac-btn', attr: { 'aria-label': 'Previous day' } });
		const nextBtn = (this.nextBtn = nav.createDiv({ cls: 'ac-btn', attr: { 'aria-label': 'Next day' } }));
		setIcon(prevBtn, 'chevron-left');
		setIcon(nextBtn, 'chevron-right');
		prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this.shiftDay(-1); });
		nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.shiftDay(1); });
		this.countEl = this.head.createDiv({ cls: 'ac-count' });
		this.toggleBtn = this.head.createDiv({ cls: 'ac-btn' });
		this.toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); this.setCollapsed(!this.settings.collapsed); });
		this.body = el.createDiv({ cls: 'ac-body' });

		this.makeDraggable();
		this.head.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			const m = new Menu();
			m.addItem((i) => i.setTitle("Open today's card as a note").setIcon('file-text').onClick(() => this.openCard()));
			m.addItem((i) => i.setTitle('Bring forward from the last card').setIcon('arrow-right').onClick(() => this.bringForward()));
			m.addSeparator();
			m.addItem((i) => i.setTitle('Reset position').setIcon('move').onClick(() => { this.settings.right = null; this.settings.bottom = null; this.applyPosition(); this.save(); }));
			m.addItem((i) => i.setTitle('Hide card').setIcon('eye-off').onClick(() => this.setVisible(false)));
			m.showAtMouseEvent(e);
		});

		el.toggleClass('is-hidden', !this.settings.visible);
		el.toggleClass('is-collapsed', this.settings.collapsed);
		this.updateToggleIcon();
		this.applyPosition();
	}

	makeDraggable() {
		let start = null;
		this.head.addEventListener('pointerdown', (e) => {
			if (e.button !== 0 || e.target.closest('.ac-btn')) return;
			const r = this.panel.getBoundingClientRect();
			start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false, onTitle: !!e.target.closest('.ac-title') };
			try { this.head.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or stale pointer */ }
		});
		this.head.addEventListener('pointermove', (e) => {
			if (!start) return;
			const dx = e.clientX - start.x;
			const dy = e.clientY - start.y;
			if (!start.moved && Math.hypot(dx, dy) < 4) return;
			start.moved = true;
			this.panel.addClass('is-dragging');
			this.place(start.left + dx, start.top + dy);
		});
		const end = () => {
			if (!start) return;
			const moved = start.moved;
			const onTitle = start.onTitle;
			start = null;
			this.panel.removeClass('is-dragging');
			if (moved) {
				this.settings.right = parseFloat(this.panel.style.right);
				this.settings.bottom = parseFloat(this.panel.style.bottom);
				this.save();
			} else if (this.settings.collapsed) {
				this.setCollapsed(false);
			} else if (onTitle) {
				this.toggleTodayTomorrow();
			}
		};
		this.head.addEventListener('pointerup', end);
		this.head.addEventListener('pointercancel', end);
	}

	// Anchored bottom-right, so expanding grows upward like a chat mole.
	place(left, top) {
		const r = this.panel.getBoundingClientRect();
		const l = Math.max(4, Math.min(left, window.innerWidth - r.width - 4));
		const t = Math.max(4, Math.min(top, window.innerHeight - r.height - 4));
		this.panel.style.right = `${window.innerWidth - l - r.width}px`;
		this.panel.style.bottom = `${window.innerHeight - t - r.height}px`;
	}

	applyPosition() {
		this.panel.style.right = `${this.settings.right ?? 24}px`;
		this.panel.style.bottom = `${this.settings.bottom ?? 36}px`;
		window.requestAnimationFrame(() => {
			const r = this.panel.getBoundingClientRect();
			if (r.width && (r.top < 4 || r.left < 4 || r.right > window.innerWidth - 4 || r.bottom > window.innerHeight - 4)) {
				this.place(r.left, r.top);
			}
		});
	}

	setVisible(v) {
		this.settings.visible = v;
		this.panel.toggleClass('is-hidden', !v);
		this.save();
		if (v) this.applyPosition();
	}

	setCollapsed(c) {
		this.settings.collapsed = c;
		if (c) this.viewDate = null;
		this.panel.toggleClass('is-collapsed', c);
		this.updateToggleIcon();
		this.save();
		this.render().then(() => this.applyPosition());
	}

	updateToggleIcon() {
		setIcon(this.toggleBtn, this.settings.collapsed ? 'maximize-2' : 'minus');
		this.toggleBtn.setAttr('aria-label', this.settings.collapsed ? 'Expand' : 'Minimize');
	}

	focusInput() {
		this.setVisible(true);
		if (this.settings.collapsed) this.setCollapsed(false);
		this.wantFocus = true;
		this.render();
	}

	// ---------- days ----------

	goTo(date) {
		this.viewDate = date && date !== this.today() ? date : null;
		if (this.settings.collapsed) { this.setCollapsed(false); return; }
		this.render();
	}

	// The future stops at tomorrow (the next workday). Today's card is the commitment; further out is the ledger's job.
	shiftDay(n) {
		const today = this.today();
		const base = this.viewDate || today;
		const tomorrow = this.nextWorkday(today);
		if (base === SOMEDAY) { if (n < 0) this.goTo(tomorrow); return; }
		if (n > 0 && base >= tomorrow) { if (this.somedaySource()) this.goTo(SOMEDAY); return; }
		if (n > 0 && base === today) { this.goTo(tomorrow); return; }
		if (n < 0 && base === tomorrow) { this.goTo(null); return; }
		this.goTo(moment(base, 'YYYY-MM-DD').add(n, 'day').format('YYYY-MM-DD'));
	}

	toggleTodayTomorrow() {
		this.goTo(this.viewDate ? null : this.nextWorkday(this.today()));
	}

	somedaySource() {
		const f = this.settings.somedaySource && this.app.vault.getAbstractFileByPath(normalizePath(this.settings.somedaySource));
		return f instanceof TFile ? f : null;
	}

	dayLabel(date, today) {
		const diff = moment(date, 'YYYY-MM-DD').diff(moment(today, 'YYYY-MM-DD'), 'days');
		if (diff === 0) return 'Today';
		if (diff === 1) return 'Tomorrow';
		if (diff === -1) return 'Yesterday';
		if (date === this.nextWorkday(today)) return moment(date, 'YYYY-MM-DD').format('dddd');
		return null;
	}

	async render() {
		const token = ++this.renderToken;
		const today = this.today();
		const date = this.settings.collapsed ? today : this.viewDate || today;
		if (date === SOMEDAY) return this.renderSomeday(token);
		const file = this.app.vault.getAbstractFileByPath(this.cardPath(date));
		const data = file instanceof TFile ? await this.app.vault.read(file) : '';
		const items = parse(data);
		const onCard = new Set(items.map((i) => i.text));
		const suggestions = readSuggestions(data).filter((s) => !onCard.has(s.text));
		const carried = await this.carryCounts(date, items);
		let prev = null;
		let prevPending = [];
		if (date === today && !items.some((i) => i.ch !== '>')) {
			prev = this.previousCard(date);
			if (prev) prevPending = await this.pending(prev);
		}
		if (token !== this.renderToken) return;
		const sameDay = this.shownDate === date;
		this.shownDate = date;
		this.panel.toggleClass('is-elsewhere', date !== today);
		this.nextBtn.toggleClass('is-disabled', date >= this.nextWorkday(today) && !this.somedaySource());

		// Keep a half-typed item through re-renders of the same day.
		const draft = this.input && sameDay ? this.input.value : '';
		const hadFocus = this.input && document.activeElement === this.input;

		const live = items.filter((i) => i.ch !== '>');
		const done = live.filter((i) => i.ch === 'x').length;
		this.countEl.setText(live.length ? `${done}/${live.length}` : '');

		this.titleEl.empty();
		const current = items.find((i) => i.ch === '/');
		const allDone = live.length > 0 && done === live.length;
		if (this.settings.collapsed && allDone) {
			this.titleEl.createSpan({ cls: 'ac-mark is-done' });
			this.titleEl.createSpan({ cls: 'ac-title-text', text: 'Did it' });
		} else if (this.settings.collapsed && current) {
			this.titleEl.createSpan({ cls: 'ac-mark is-progress' });
			this.titleEl.createSpan({ cls: 'ac-title-text', text: display(current.text).label });
		} else {
			const label = this.dayLabel(date, today);
			const full = moment(date, 'YYYY-MM-DD').format('ddd D MMM');
			this.titleEl.createSpan({ cls: 'ac-title-text', text: label || full });
			if (label) this.titleEl.createSpan({ cls: 'ac-title-date', text: full });
			this.titleEl.setAttr('aria-label', date === today ? `Go to ${(this.dayLabel(this.nextWorkday(today), today) || 'next day').toLowerCase()}` : 'Back to today');
		}

		this.body.empty();
		const list = this.body.createDiv({ cls: 'ac-list' });
		for (const it of items) this.renderItem(list, it, carried.get(it.text) || 0);

		this.input = null;
		if (items.length < this.settings.maxItems) {
			const row = list.createDiv({ cls: 'ac-row ac-input-row' });
			const mark = row.createSpan({ cls: allDone ? 'ac-mark is-cleared' : 'ac-mark is-ghost' });
			if (allDone) {
				setIcon(mark, 'party-popper');
				if (!mark.querySelector('svg')) setIcon(mark, 'sparkles'); // older Obsidian builds lack party-popper
			}
			// A cleared card reads as finished: "Did it." is a label, not a field.
			// Clicking it, or the "Add an item" command, opens an empty field for one more.
			const adding = !!draft || hadFocus || this.wantFocus;
			if (allDone && !adding) {
				row.addClass('is-cleared-row');
				row.createSpan({ cls: 'ac-cleared-text', text: 'Did it.' });
				// Click to add one more: "Did it." clears out and the row becomes a field.
				row.addEventListener('click', () => { this.wantFocus = true; this.render(); });
			} else {
				const input = (this.input = row.createEl('input', {
					cls: 'ac-input',
					attr: {
						type: 'text',
						spellcheck: 'false',
						placeholder: allDone ? '' : items.length ? '' : date < today ? 'Nothing on this card.' : `What matters ${date === today ? 'today' : (this.dayLabel(date, today) || 'that day').toLowerCase()}?`,
						'aria-label': 'Enter to add · Shift+Enter links the open note',
					},
				}));
				input.value = draft;
				// Suggestions step aside while you type; the rows stay so the card keeps its height.
				const typing = () => this.panel.toggleClass('is-typing', !!input.value);
				input.addEventListener('input', typing);
				typing();
				input.addEventListener('keydown', async (e) => {
					if (e.key === 'Escape') { input.blur(); return; }
					if (e.key !== 'Enter' || e.isComposing) return;
					e.preventDefault();
					const text = input.value.trim();
					if (!text) return;
					input.value = '';
					this.wantFocus = true;
					if (!(await this.addFromInput(text, e.shiftKey))) input.value = text;
				});
				// Leaving an empty field on a cleared card puts "Did it." back.
				if (allDone) input.addEventListener('blur', () => { if (!input.value.trim()) window.setTimeout(() => this.render(), 0); });
			}
			const room = Math.max(0, this.settings.maxItems - items.length - 1);
			const shown = suggestions.slice(0, room);
			for (const s of shown) this.renderSuggestion(list, s, date);
			for (let n = items.length + 1 + shown.length; n < this.settings.maxItems; n++) list.createDiv({ cls: 'ac-row ac-empty' });
		}

		if (prevPending.length) {
			const label = `Bring forward ${prevPending.length} from ${moment(prev.basename, 'YYYY-MM-DD').format('ddd')} →`;
			const fwd = this.body.createDiv({ cls: 'ac-forward', text: label });
			fwd.addEventListener('click', () => this.bringForward());
		}

		this.panel.toggleClass('is-cleared', allDone);
		// Celebrate the moment it happens: once per card, only after this session saw it unfinished.
		if (!allDone) this.seenIncomplete = date;
		else if (this.seenIncomplete === date && this.settings.celebratedOn !== date) {
			this.settings.celebratedOn = date;
			this.save();
			this.celebrate();
			this.app.workspace.trigger('tobedid:cleared', { date, path: this.cardPath(date), ...stats(items) });
		}

		if (this.input && (this.wantFocus || hadFocus)) this.input.focus();
		this.wantFocus = false;
	}

	celebrate() {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const p = this.panel;
		p.removeClass('is-celebrating');
		void p.offsetWidth; // restart the animation if it is already running
		p.addClass('is-celebrating');
		p.querySelectorAll('.ac-row .ac-mark.is-done').forEach((m, i) => m.style.setProperty('--ac-delay', `${i * 70}ms`));

		const origin = this.settings.collapsed || !this.lastMarkPoint
			? { x: 20, y: this.settings.collapsed ? p.offsetHeight / 2 : 20 }
			: this.lastMarkPoint;
		const burst = p.createDiv({ cls: 'ac-burst' });
		burst.style.left = `${origin.x}px`;
		burst.style.top = `${origin.y}px`;
		const n = 12;
		for (let i = 0; i < n; i++) {
			const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
			const d = 28 + Math.random() * 26;
			const spark = burst.createSpan({ cls: i % 3 === 0 ? 'ac-spark' : 'ac-spark is-accent' });
			spark.style.setProperty('--dx', `${Math.cos(a) * d}px`);
			spark.style.setProperty('--dy', `${Math.sin(a) * d}px`);
			spark.style.setProperty('--size', `${4 + Math.random() * 3}px`);
		}
		window.clearTimeout(this.celebrateTimer);
		this.celebrateTimer = window.setTimeout(() => {
			burst.remove();
			p.removeClass('is-celebrating');
		}, 1600);
	}

	// ---------- sending an item somewhere: a chat panel, the clipboard, or any registered target ----------

	registerBuiltInTargets() {
		const app = this.app;
		// Claudian's chat view accepts text into its composer without sending, so the question stays the person's.
		this.sendTargets.set('claudian', {
			id: 'claudian',
			name: 'Claudian',
			available: () => !!app.plugins.plugins['realclaudian'],
			async send(text) {
				const find = () => {
					let leaf = null;
					app.workspace.iterateAllLeaves((l) => {
						if (!leaf && l.view && typeof l.view.appendToActiveInput === 'function') leaf = l;
					});
					return leaf;
				};
				let leaf = find();
				if (!leaf) {
					app.commands.executeCommandById('realclaudian:open-view');
					for (let i = 0; i < 20 && !(leaf = find()); i++) await new Promise((r) => window.setTimeout(r, 100));
				}
				if (!leaf) return false;
				app.workspace.revealLeaf(leaf);
				const ok = leaf.view.appendToActiveInput(text);
				if (typeof leaf.view.focusActiveInput === 'function') leaf.view.focusActiveInput();
				return !!ok;
			},
		});
		this.sendTargets.set('clipboard', {
			id: 'clipboard',
			name: 'Clipboard',
			available: () => true,
			async send(text) {
				await navigator.clipboard.writeText(text);
				new Notice('Reference copied');
				return true;
			},
		});
	}

	sendTarget() {
		const chosen = this.sendTargets.get(this.settings.sendTo);
		if (chosen && chosen.available()) return chosen;
		for (const t of this.sendTargets.values()) if (t.id !== 'clipboard' && t.available()) return t;
		return this.sendTargets.get('clipboard');
	}

	async send(text, target = this.sendTarget()) {
		this.app.workspace.trigger('tobedid:send', { text, target: target.id });
		let ok = false;
		try { ok = await target.send(text); } catch (e) { ok = false; }
		if (!ok && target.id !== 'clipboard') await this.sendTargets.get('clipboard').send(text);
	}

	// A compact reference: enough for a person or an agent to find the line and its context.
	cardRef(it) {
		const { label, target } = display(it.text);
		const today = this.today();
		const day = this.dayLabel(this.shownDate, today);
		const where = day ? `${day.toLowerCase()}'s card` : `the card for ${moment(this.shownDate, 'YYYY-MM-DD').format('ddd D MMM')}`;
		const context = target ? `, context [[${target}]]` : '';
		return `"${label}" (${(LABEL[it.ch] || 'New').toLowerCase()}) on ${where}, ${this.cardPath(this.shownDate)} line ${it.line + 1}${context}. `;
	}

	somedayRef(it, src) {
		return `"${it.headline}" (${(LABEL[it.ch] || 'New').toLowerCase()}), open item in ${src.path} line ${it.line + 1}. `;
	}

	addSendItems(menu, ref) {
		const t = this.sendTarget();
		if (t.id !== 'clipboard') menu.addItem((i) => i.setTitle(`Ask ${t.name}`).setIcon('message-square').onClick(() => this.send(ref, t)));
		menu.addItem((i) => i.setTitle('Copy reference').setIcon('copy').onClick(() => this.send(ref, this.sendTargets.get('clipboard'))));
	}

	// ---------- suggestions ----------

	async addSuggestions(date, texts, source) {
		const file = await this.ensureCard(date);
		const onCard = new Set(parse(await this.app.vault.read(file)).map((i) => i.text));
		let added = 0;
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			const list = Array.isArray(fm.suggestions) ? fm.suggestions : [];
			const have = new Set(list.map((s) => (typeof s === 'string' ? s : s && s.text)));
			for (const raw of texts) {
				const text = String(raw || '').trim();
				if (!text || have.has(text) || onCard.has(text)) continue;
				list.push(source ? { text, source } : text);
				have.add(text);
				added++;
			}
			if (list.length) fm.suggestions = list;
		});
		return added;
	}

	async removeSuggestion(date, text) {
		const file = this.app.vault.getAbstractFileByPath(this.cardPath(date));
		if (!(file instanceof TFile)) return false;
		let removed = false;
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			if (!Array.isArray(fm.suggestions)) return;
			const next = fm.suggestions.filter((s) => (typeof s === 'string' ? s : s && s.text) !== text);
			removed = next.length !== fm.suggestions.length;
			if (next.length) fm.suggestions = next;
			else delete fm.suggestions;
		});
		return removed;
	}

	async acceptSuggestion(date, text) {
		const result = await this.appendItem(date, text);
		if (result === 'full') { new Notice(`The card holds ${this.settings.maxItems}. Finish or carry something first.`); return result; }
		await this.removeSuggestion(date, text);
		return result;
	}

	renderSuggestion(list, s, date) {
		const { label } = display(s.text);
		const row = list.createDiv({ cls: 'ac-row ac-suggestion' });
		row.createSpan({ cls: 'ac-mark is-ghost' });
		const text = row.createSpan({ cls: 'ac-text', text: label });
		text.setAttr('aria-label', s.source ? `Suggested by ${s.source} · click to keep` : 'Suggested · click to keep');
		const keep = () => this.acceptSuggestion(date, s.text);
		text.addEventListener('click', keep);
		const add = row.createSpan({ cls: 'ac-go ac-keep', attr: { 'aria-label': 'Keep' } });
		setIcon(add, 'plus');
		add.addEventListener('click', keep);
		const drop = row.createSpan({ cls: 'ac-go ac-drop', attr: { 'aria-label': 'Dismiss' } });
		setIcon(drop, 'x');
		drop.addEventListener('click', () => this.removeSuggestion(date, s.text));
	}

	// ---------- carry history: read from past cards, never stored ----------

	// How many consecutive earlier cards carried each of these lines forward.
	async carryCounts(date, items) {
		const counts = new Map();
		let pending = new Set(items.filter((i) => i.ch === ' ' || i.ch === '/').map((i) => i.text));
		if (!pending.size) return counts;
		const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.folder));
		if (!(folder instanceof TFolder)) return counts;
		const cards = folder.children
			.filter((f) => f instanceof TFile && /^\d{4}-\d{2}-\d{2}$/.test(f.basename) && f.basename < date)
			.sort((a, b) => b.basename.localeCompare(a.basename))
			.slice(0, 21);
		for (const f of cards) {
			if (!pending.size) break;
			const carried = new Set(parse(await this.app.vault.cachedRead(f)).filter((i) => i.ch === '>').map((i) => i.text));
			for (const t of [...pending]) {
				if (carried.has(t)) counts.set(t, (counts.get(t) || 0) + 1);
				else pending.delete(t);
			}
		}
		return counts;
	}

	stopRegex() {
		const words = (this.settings.somedayStop || '').split(',').map((s) => s.trim()).filter(Boolean)
			.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		return words.length ? new RegExp(`^#{1,6}\\s+(?:${words.join('|')})\\b`, 'i') : null;
	}

	// Take a line off the card and put it back on the longer list, above any Retired/Archive/Done heading.
	async moveToSomeday(it, date = this.shownDate) {
		const src = this.somedaySource();
		if (!src) return;
		const stop = this.stopRegex();
		await this.app.vault.process(src, (data) => {
			const lines = data.split('\n');
			const line = `- [ ] ${it.text}`;
			const idx = stop ? lines.findIndex((l) => stop.test(l)) : -1;
			if (idx === -1) {
				while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
				lines.push(line, '');
			} else {
				let at = idx;
				while (at > 0 && lines[at - 1].trim() === '') at--;
				lines.splice(at, 0, line);
			}
			return lines.join('\n');
		});
		const card = this.app.vault.getAbstractFileByPath(this.cardPath(date));
		if (card instanceof TFile) {
			await this.app.vault.process(card, (data) => {
				const lines = data.split('\n');
				const m = TASK_RE.exec(lines[it.line] || '');
				if (m && m[2] === it.text) lines.splice(it.line, 1);
				return lines.join('\n');
			});
		}
		new Notice(`Moved to ${src.basename}`);
	}

	// ---------- someday: a window onto a longer list, never a copy of it ----------

	async somedayItems() {
		const src = this.somedaySource();
		if (!src) return { src: null, items: [] };
		const lines = (await this.app.vault.read(src)).split('\n');
		const hide = (this.settings.somedayHide || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
		const stop = this.stopRegex();
		const items = [];
		for (let i = 0; i < lines.length; i++) {
			if (stop && stop.test(lines[i])) break;
			const m = TASK_RE.exec(lines[i]);
			if (!m || (m[1] !== ' ' && m[1] !== '/')) continue;
			const low = m[2].toLowerCase();
			if (hide.some((h) => low.includes(h))) continue;
			const due = dueDate(m[2]);
			const link = (/\[\[([^\]|#]+)/.exec(m[2]) || [])[1] || null;
			items.push({ line: i, ch: m[1], text: m[2], state: STATE[m[1]], headline: headline(m[2]), due, link });
		}
		const rank = (i) => (i.due ? 0 : i.ch === '/' ? 1 : 2);
		items.sort((a, b) => rank(a) - rank(b) || (a.due && b.due ? a.due.localeCompare(b.due) : 0) || a.line - b.line);
		return { src, items };
	}

	async renderSomeday(token) {
		const { src, items } = await this.somedayItems();
		if (token !== this.renderToken) return;
		this.shownDate = SOMEDAY;
		this.input = null;
		this.panel.addClass('is-elsewhere');
		this.panel.removeClass('is-cleared');
		this.nextBtn.addClass('is-disabled');
		this.countEl.setText(items.length ? String(items.length) : '');
		this.titleEl.empty();
		this.titleEl.createSpan({ cls: 'ac-title-text', text: 'Someday' });
		if (src) this.titleEl.createSpan({ cls: 'ac-title-date', text: src.basename });
		this.titleEl.setAttr('aria-label', 'Back to today');

		this.body.empty();
		const list = this.body.createDiv({ cls: 'ac-list' });
		const max = this.settings.maxItems;
		const fits = items.length <= max;
		const shown = fits ? items : items.slice(0, max - 1);
		const today = this.today();
		for (const it of shown) this.renderSomedayItem(list, it, src, today);
		if (!fits) {
			const more = list.createDiv({ cls: 'ac-row ac-more', text: `+${items.length - shown.length} more in ${src.basename}` });
			more.addEventListener('click', () => this.openAt(src, 0));
		}
		for (let n = Math.min(items.length, max); n < max; n++) list.createDiv({ cls: 'ac-row ac-empty' });
	}

	renderSomedayItem(list, it, src, today) {
		const row = list.createDiv({ cls: `ac-row has-link is-${it.state}` });
		const mark = row.createSpan({ cls: `ac-mark is-${it.state}`, attr: { 'aria-label': LABEL[it.ch] } });
		mark.addEventListener('click', () => this.setSourceState(src, it, NEXT[it.ch]));
		const text = row.createSpan({ cls: 'ac-text', text: it.headline });
		if (it.headline.length > 34) text.setAttr('aria-label', it.headline);
		text.addEventListener('click', (e) => (e.altKey ? this.send(this.somedayRef(it, src)) : this.openAt(src, it.line)));
		if (it.due) {
			row.createSpan({ cls: `ac-due${it.due < today ? ' is-overdue' : ''}`, text: moment(it.due, 'YYYY-MM-DD').format('D MMM') });
		}
		row.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			const m = new Menu();
			const tomorrow = this.nextWorkday(today);
			const tLabel = this.dayLabel(tomorrow, today) || 'tomorrow';
			m.addItem((i) => i.setTitle('Do today').setIcon('arrow-down-to-line').onClick(() => this.pull(it, src, today, 'today')));
			m.addItem((i) => i.setTitle(`Do ${tLabel.toLowerCase()}`).setIcon('arrow-right').onClick(() => this.pull(it, src, tomorrow, tLabel.toLowerCase())));
			m.addSeparator();
			for (const ch of [' ', '/', 'x']) {
				m.addItem((i) => i.setTitle(LABEL[ch]).setChecked(it.ch === ch).onClick(() => this.setSourceState(src, it, ch)));
			}
			m.addSeparator();
			m.addItem((i) => i.setTitle(`Open in ${src.basename}`).setIcon('file-text').onClick(() => this.openAt(src, it.line)));
			this.addSendItems(m, this.somedayRef(it, src));
			m.showAtMouseEvent(e);
		});
	}

	async pull(it, src, date, label) {
		const result = await this.appendItem(date, `${it.headline} → [[${it.link || src.basename}]]`);
		if (result === 'added') new Notice(`On ${label}'s card`);
		else if (result === 'duplicate') new Notice(`Already on ${label}'s card`);
		else if (result === 'full') new Notice(`${label.charAt(0).toUpperCase() + label.slice(1)}'s card is full`);
	}

	async setSourceState(src, it, ch) {
		await this.app.vault.process(src, (data) => {
			const lines = data.split('\n');
			const m = TASK_RE.exec(lines[it.line] || '');
			if (!m || m[2] !== it.text) { new Notice(`${src.basename} changed underneath. Try again.`); return data; }
			lines[it.line] = `- [${ch}] ${m[2]}`;
			return lines.join('\n');
		});
	}

	async openAt(file, line) {
		await this.app.workspace.getLeaf(false).openFile(file, { eState: { line } });
	}

	renderItem(list, it, carriedTimes = 0) {
		const state = STATE[it.ch] || 'new';
		const { label, target } = display(it.text);
		const row = list.createDiv({ cls: `ac-row is-${state}` });

		const mark = row.createSpan({ cls: `ac-mark is-${state}`, attr: { 'aria-label': LABEL[it.ch] || 'New' } });
		if (it.ch !== '>') mark.addEventListener('click', () => {
			this.lastMarkPoint = { x: mark.offsetLeft + mark.offsetWidth / 2, y: mark.offsetTop + mark.offsetHeight / 2 };
			this.setState(it, NEXT[it.ch] ?? ' ');
		});

		const text = row.createSpan({ cls: 'ac-text', text: label });
		const tip = [];
		if (label.length > 34) tip.push(label);
		if (carriedTimes) tip.push(`Carried ${carriedTimes === 1 ? 'once' : `${carriedTimes} times`}`);
		if (tip.length) text.setAttr('aria-label', tip.join(' · '));
		text.addEventListener('click', (e) => {
			if (!e.altKey) return;
			e.stopImmediatePropagation();
			this.send(this.cardRef(it));
		});

		if (target) {
			row.addClass('has-link');
			text.addEventListener('click', (e) => this.openLink(target, e));
			const go = row.createSpan({ cls: 'ac-go', attr: { 'aria-label': `Open ${linkLabel(target)}` } });
			setIcon(go, 'arrow-up-right');
			go.addEventListener('click', (e) => this.openLink(target, e));
		}

		row.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			const m = new Menu();
			for (const ch of [' ', '/', 'x']) {
				m.addItem((i) => i.setTitle(LABEL[ch]).setChecked(it.ch === ch).onClick(() => this.setState(it, ch)));
			}
			if (it.ch === ' ' || it.ch === '/') {
				const day = moment(this.nextWorkday(this.shownDate), 'YYYY-MM-DD').format('ddd');
				m.addItem((i) => i.setTitle(`Carry over to ${day}`).setIcon('arrow-right').onClick(() => this.carry(it)));
				const src = this.somedaySource();
				if (src) m.addItem((i) => i.setTitle(`Send to Someday`).setIcon('archive').onClick(() => this.moveToSomeday(it)));
			}
			m.addSeparator();
			if (target) m.addItem((i) => i.setTitle('Open linked note').setIcon('arrow-up-right').onClick(() => this.openLink(target)));
			m.addItem((i) => i.setTitle('Edit on the card').setIcon('pencil').onClick(() => this.openCard(it.line)));
			this.addSendItems(m, this.cardRef(it));
			m.showAtMouseEvent(e);
		});
	}
};

class TobedidSettings extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		const p = this.plugin;
		containerEl.empty();
		new Setting(containerEl).setName('Cards folder').setDesc('One note per day, named YYYY-MM-DD.')
			.addText((t) => t.setPlaceholder('daily/cards').setValue(p.settings.folder).onChange(async (v) => { p.settings.folder = normalizePath(v.trim() || 'daily/cards'); await p.save(); p.render(); }));
		new Setting(containerEl).setName('Lines on a card').setDesc('The card stops taking new items at this number. Carried items can still land.')
			.addSlider((s) => s.setLimits(3, 15, 1).setValue(p.settings.maxItems).setDynamicTooltip().onChange(async (v) => { p.settings.maxItems = v; await p.save(); p.render(); }));
		new Setting(containerEl).setName('Skip weekends when carrying over').setDesc('Friday carries to Monday.')
			.addToggle((t) => t.setValue(p.settings.skipWeekends).onChange(async (v) => { p.settings.skipWeekends = v; await p.save(); }));
		new Setting(containerEl).setName('Someday list').setDesc('A note with a longer list of checkboxes, shown after tomorrow as Someday. Leave empty to stop at tomorrow.')
			.addText((t) => t.setPlaceholder('Projects/Backlog.md').setValue(p.settings.somedaySource).onChange(async (v) => { p.settings.somedaySource = v.trim(); await p.save(); p.render(); }));
		new Setting(containerEl).setName('Hide from Someday').setDesc('Comma-separated. Lines containing any of these never show on the card, which floats over everything, screen shares included.')
			.addText((t) => t.setPlaceholder('private, salary').setValue(p.settings.somedayHide).onChange(async (v) => { p.settings.somedayHide = v; await p.save(); p.render(); }));
		new Setting(containerEl).setName('Stop Someday at headings').setDesc('Comma-separated. The list ends at the first heading that starts with one of these.')
			.addText((t) => t.setValue(p.settings.somedayStop).onChange(async (v) => { p.settings.somedayStop = v; await p.save(); p.render(); }));
		new Setting(containerEl).setName('Send items to').setDesc('Option-click an item, or right-click and Ask, to drop a reference to it into a chat without sending. Auto uses the first installed target and falls back to the clipboard.')
			.addDropdown((d) => {
				d.addOption('auto', 'Auto');
				for (const t of p.sendTargets.values()) d.addOption(t.id, t.available() ? t.name : `${t.name} (not installed)`);
				d.setValue(p.settings.sendTo).onChange(async (v) => { p.settings.sendTo = v; await p.save(); });
			});
		new Setting(containerEl).setName('Write progress to frontmatter').setDesc('Keeps committed, done, in_progress, open, carried and progress on each card, for Bases, Dataview and agents.')
			.addToggle((t) => t.setValue(p.settings.writeStats).onChange(async (v) => { p.settings.writeStats = v; await p.save(); }));
	}
}
