// Agent Board client. No framework, no build step: the whole thing is one file you can read in a sitting.

const $ = (sel, el = document) => el.querySelector(sel);

/** Tiny element builder. Text always goes through text nodes, so ticket content can never inject markup. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const S = {
  columns: [],
  tickets: new Map(),
  status: {},
  workspace: {},
  conn: 'connecting',
  tab: 'backlog',
  lastLog: new Map(),
  openId: null,
  sheet: null, // refs into the open ticket sheet
};

// ---- api -----------------------------------------------------------------------------------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  if (res.status === 401 && !url.startsWith('/api/login')) {
    showLogin();
    throw new Error('Signed out');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, ms = 3000) {
  const box = $('#toasts');
  const el = h('div', { class: 'toast', role: 'status' }, msg);
  box.append(el);
  while (box.childElementCount > 3) box.firstChild.remove();
  // A popover lives in the top layer, so toasts show above an open sheet instead of behind its dimmed backdrop.
  try {
    if (box.matches(':popover-open')) box.hidePopover();
    box.showPopover();
  } catch {}
  setTimeout(() => {
    el.remove();
    if (!box.childElementCount) try { box.hidePopover(); } catch {}
  }, ms);
}

const run = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err.message !== 'Signed out') toast(err.message);
  }
};

// ---- formatting ----------------------------------------------------------------------------

const money = (n) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`.replace(/0+$/, '').replace(/\.$/, '.00'));
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function dur(a, b) {
  const s = Math.round(((b || Date.now()) - a) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STAGE_WORD = { in_work: 'Developing', testing: 'Testing', review: 'Reviewing' };
const AGENT_NAME = { developer: 'Developer', tester: 'Tester', reviewer: 'Reviewer' };

function chipFor(t) {
  const col = S.columns.find((c) => c.id === t.column);
  switch (t.status) {
    case 'running': return ['running', STAGE_WORD[t.column] || 'Working'];
    case 'queued': return ['', 'Queued'];
    case 'blocked': return ['blocked', 'Needs you'];
    case 'failed': return ['failed', 'Failed'];
    case 'approved': return ['approved', 'Approved'];
    default:
      if (t.column === 'done') return ['done', 'Done'];
      return col?.agent ? ['', 'Idle'] : ['none', ''];
  }
}

// ---- board rendering -----------------------------------------------------------------------

const cardEls = new Map();
const colEls = new Map();
let renderQueued = false;
const scheduleRender = () => {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
};

function buildBoard() {
  const tabs = $('#tabs');
  const board = $('#board');
  tabs.replaceChildren();
  board.replaceChildren();
  colEls.clear();
  for (const c of S.columns) {
    tabs.append(
      h('button', { class: 'tab', role: 'tab', id: `tab-${c.id}`, 'aria-selected': 'false', onclick: () => goTab(c.id) },
        h('span', { text: c.title }), h('span', { class: 'count', id: `count-${c.id}` }, '0'), h('span', { class: 'pulse', id: `pulse-${c.id}`, hidden: true })),
    );
    const col = h('section', { class: 'col', id: `col-${c.id}`, 'aria-label': c.title, 'data-col': c.id },
      h('div', { class: 'col-head' }, h('span', { text: c.title }), h('span', { class: 'count', id: `dcount-${c.id}` }, '0')),
      c.agent ? h('p', { class: 'col-hint', text: `${AGENT_NAME[c.agent]} agent picks these up automatically` }) : null,
      h('div', { class: 'empty', id: `empty-${c.id}`, text: emptyText(c) }),
    );
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('drop');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const id = e.dataTransfer.getData('text/plain');
      if (id && S.tickets.get(id)?.column !== c.id) run(() => api('POST', `/api/tickets/${id}/move`, { column: c.id }));
    });
    colEls.set(c.id, col);
    board.append(col);
  }
  board.addEventListener('scroll', onBoardScroll, { passive: true });
}

function emptyText(c) {
  if (c.id === 'backlog') return 'No tickets yet. Tap + to add one.';
  if (c.id === 'done') return 'Approved work lands here.';
  return `Drop a ticket here and the ${AGENT_NAME[c.agent].toLowerCase()} agent starts on it.`;
}

function goTab(id, smooth = true) {
  S.tab = id;
  const board = $('#board');
  const i = S.columns.findIndex((c) => c.id === id);
  if (getComputedStyle($('#tabs')).display !== 'none') board.scrollTo({ left: i * board.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
  markTabs();
}

function markTabs() {
  for (const c of S.columns) {
    const on = c.id === S.tab;
    const tab = $(`#tab-${c.id}`);
    tab.setAttribute('aria-selected', String(on));
    if (on) tab.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
}

let scrollTimer;
function onBoardScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const board = $('#board');
    const i = Math.round(board.scrollLeft / Math.max(1, board.clientWidth));
    const id = S.columns[Math.min(S.columns.length - 1, Math.max(0, i))]?.id;
    if (id && id !== S.tab) {
      S.tab = id;
      markTabs();
    }
  }, 60);
}

function cardAction(t) {
  if (t.column === 'backlog') return { label: 'Start', primary: true, fn: () => api('POST', `/api/tickets/${t.id}/move`, { column: 'in_work' }) };
  if (t.status === 'approved') return { label: 'Mark done', primary: true, fn: () => api('POST', `/api/tickets/${t.id}/move`, { column: 'done' }) };
  if ((t.status === 'blocked' || t.status === 'failed') && S.columns.find((c) => c.id === t.column)?.agent) {
    return { label: 'Retry', primary: false, fn: () => api('POST', `/api/tickets/${t.id}/retry`) };
  }
  return null;
}

function makeCard(id) {
  const el = h('article', { class: 'card', draggable: true });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  return el;
}

function fillCard(el, t) {
  const [chipCls, chipText] = chipFor(t);
  const live = S.lastLog.get(t.id);
  const act = cardAction(t);
  // Rebuilding a card under someone's thumb swallows the tap, so only touch the DOM when something visible changed.
  const sig = JSON.stringify([t.title, t.status, t.statusNote, t.costUsd, t.loops, t.column, live]);
  if (el._sig === sig) return;
  el._sig = sig;
  el.dataset.status = t.status;
  el.replaceChildren(
    h('button', { class: 'card-main', onclick: () => openTicket(t.id), 'aria-label': `${t.id}: ${t.title}` },
      h('div', { class: 'card-top' }, h('span', { class: 'tid mono', text: t.id }), chipText ? h('span', { class: `chip ${chipCls}`, text: chipText }) : null),
      h('div', { class: 'card-title', text: t.title }),
      t.status === 'running' && live ? h('div', { class: 'card-live', text: live }) : null,
      (t.status === 'blocked' || t.status === 'failed' || t.status === 'approved') && t.statusNote ? h('div', { class: 'card-note', text: t.statusNote }) : null,
      t.status === 'queued' && t.statusNote ? h('div', { class: 'card-live', text: t.statusNote }) : null),
    h('div', { class: 'card-foot' },
      t.costUsd > 0 ? h('span', { text: money(t.costUsd), title: 'Spent on this ticket' }) : null,
      t.loops > 0 ? h('span', { text: `↻ ${t.loops}`, title: 'Times sent back' }) : null,
      h('span', { class: 'grow' }),
      act ? h('button', { class: `card-action ${act.primary ? 'primary' : ''}`, text: act.label, onclick: () => run(act.fn) }) : null),
  );
}

function render() {
  // header
  const st = S.status;
  $('#spend').textContent = st.dailyBudgetUsd > 0 ? `${money(st.spentToday || 0)} / $${st.dailyBudgetUsd}` : st.spentToday ? money(st.spentToday) : '';
  const conn = $('#conn');
  conn.className = `dot ${S.conn === 'ok' ? 'ok' : ''}`;
  conn.setAttribute('aria-label', S.conn === 'ok' ? 'Live' : 'Reconnecting');
  const banner = $('#banner');
  banner.hidden = !st.paused;
  const limited = st.rateLimitedUntil > Date.now();
  banner.hidden = !st.paused && !limited;
  if (limited) banner.textContent = `Claude usage limit reached. Agents resume automatically around ${new Date(st.rateLimitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}.`;
  else if (st.paused) banner.textContent = `Agents paused: today's $${st.dailyBudgetUsd} budget is used up. Raise DAILY_BUDGET_USD or wait until tomorrow.`;

  // cards
  const byCol = new Map(S.columns.map((c) => [c.id, []]));
  for (const t of S.tickets.values()) byCol.get(t.column)?.push(t);
  for (const [colId, list] of byCol) {
    list.sort((a, b) => (colId === 'backlog' ? a.createdAt - b.createdAt : b.movedAt - a.movedAt));
    const colEl = colEls.get(colId);
    const empty = $(`#empty-${colId}`);
    empty.hidden = list.length > 0;
    let anchor = empty;
    for (const t of list) {
      let el = cardEls.get(t.id);
      if (!el) cardEls.set(t.id, (el = makeCard(t.id)));
      fillCard(el, t);
      // Only touch the DOM order when it is actually wrong, so scrolling and taps are never disturbed.
      const want = anchor.nextElementSibling;
      if (want !== el) colEl.insertBefore(el, want);
      anchor = el;
    }
    $(`#count-${colId}`).textContent = list.length;
    $(`#dcount-${colId}`).textContent = list.length;
    $(`#pulse-${colId}`).hidden = !list.some((t) => t.status === 'running');
  }
  for (const [id, el] of cardEls) {
    if (!S.tickets.has(id)) {
      el.remove();
      cardEls.delete(id);
    }
  }
  if (S.openId) refreshSheet();
}

// ---- ticket sheet --------------------------------------------------------------------------

const sheet = () => $('#sheet');

function closeSheet() {
  S.openId = null;
  S.sheet = null;
  if (sheet().open) sheet().close();
}

async function openTicket(id) {
  const full = await run(() => api('GET', `/api/tickets/${id}`));
  if (!full) return;
  S.tickets.set(id, { ...S.tickets.get(id), ...full });
  S.openId = id;
  buildSheet(full);
  if (!sheet().open) sheet().showModal();
  refreshSheet();
}

function buildSheet(t) {
  const el = sheet();
  const refs = {};
  S.sheet = refs;

  refs.id = h('span', { class: 'tid mono' });
  refs.chip = h('span', { class: 'chip' });
  refs.title = h('input', { type: 'text', class: 'title-input', id: 'sheet-title', maxLength: 200, 'aria-label': 'Title', value: t.title });
  refs.desc = h('textarea', { id: 'f-desc', rows: 4, maxLength: 10000, placeholder: 'What should the agents build? Acceptance criteria help a lot.', value: t.description });
  refs.save = h('button', { class: 'btn primary', text: 'Save changes', hidden: true, onclick: saveEdits });
  const markDirty = () => {
    const cur = S.tickets.get(S.openId);
    refs.save.hidden = refs.title.value === cur.title && refs.desc.value === cur.description;
  };
  refs.title.addEventListener('input', markDirty);
  refs.desc.addEventListener('input', markDirty);

  refs.note = h('div', { class: 'note' });
  refs.actions = h('div', { class: 'row' });
  refs.feedback = h('details', { class: 'fb' });
  refs.moves = h('div', { class: 'moves', role: 'group', 'aria-label': 'Move to column' });
  refs.log = h('div', { class: 'log', tabIndex: 0, 'aria-label': 'Agent activity', role: 'log' });
  refs.changes = h('div', { class: 'changes' }, h('p', { class: 'muted', text: 'Loading…' }));
  refs.runs = h('div', { class: 'runs' });
  refs.comments = h('div', { class: 'comments' });
  refs.commentBox = h('textarea', { rows: 2, placeholder: 'Add a note or answer a question. Agents read these.', maxLength: 4000, 'aria-label': 'Comment' });
  refs.commentBtns = h('div', { class: 'row' });
  refs.meta = h('dl', { class: 'kv' });
  refs.delete = h('button', { class: 'btn danger', text: 'Delete ticket', onclick: onDelete });

  refs.field = (label, forId, ...kids) => h('div', { class: 'field' }, h('label', { for: forId, text: label }), ...kids);

  el.replaceChildren(
    h('div', { class: 'sheet-grab' }),
    h('div', { class: 'sheet-head' }, refs.id, refs.chip, h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeSheet }, closeIcon())),
    h('div', { class: 'sheet-body' },
      refs.title,
      refs.note,
      refs.actions,
      refs.feedback,
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Activity' }), refs.log),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Move to' }), refs.moves),
      refs.field('Description', 'f-desc', refs.desc),
      refs.save,
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Changes' }), refs.changes),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Runs' }), refs.runs),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Notes' }), refs.comments, refs.commentBox, refs.commentBtns),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Details' }), refs.meta),
      refs.delete),
  );
  el.setAttribute('aria-labelledby', 'sheet-title');

  refs.log.replaceChildren();
  if (t.log.length === 0) refs.log.append(h('div', { class: 'log-empty', text: 'Nothing yet.' }));
  for (const entry of t.log) appendLog(entry, true);
  refs.log.scrollTop = refs.log.scrollHeight;
}

const closeIcon = () => {
  const svg = h('span');
  svg.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  return svg;
};

function appendLog(entry, initial = false) {
  const refs = S.sheet;
  if (!refs) return;
  const stick = initial || refs.log.scrollHeight - refs.log.scrollTop - refs.log.clientHeight < 40;
  if (refs.log.firstChild?.classList.contains('log-empty')) refs.log.replaceChildren();
  const prefix = { tool: '› ', verdict: '✓ ', error: '✗ ' }[entry.kind] || '';
  refs.log.append(h('div', { class: entry.kind }, h('time', { text: clock(entry.t) }), prefix + entry.text));
  while (refs.log.childElementCount > 400) refs.log.firstChild.remove();
  if (stick) refs.log.scrollTop = refs.log.scrollHeight;
}

async function loadChanges(id) {
  const refs = S.sheet;
  if (!refs) return;
  const d = await api('GET', `/api/tickets/${id}/diff`).catch(() => null);
  if (!d || S.openId !== id) return;
  if (!d.files.length) return refs.changes.replaceChildren(h('p', { class: 'muted', text: 'No changes on the branch yet.' }));
  const add = d.files.reduce((n, f) => n + f.added, 0);
  const del = d.files.reduce((n, f) => n + f.removed, 0);
  const lines = d.patch.split('\n').slice(0, 600);
  refs.changes.replaceChildren(
    h('p', { class: 'muted', text: `${d.files.length} file${d.files.length === 1 ? '' : 's'}, +${add} −${del}` }),
    h('div', { class: 'files' }, d.files.map((f) => h('div', { class: 'file' }, h('span', { class: 'mono grow', text: f.file }), h('span', { class: 'plus', text: f.binary ? 'binary' : `+${f.added}` }), f.binary ? null : h('span', { class: 'minus', text: `−${f.removed}` })))),
    h('details', { class: 'fb' }, h('summary', { text: 'Show full diff' }),
      h('div', { class: 'patch mono' }, lines.map((l) => h('div', { class: l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '', text: l || ' ' })),
        d.truncated || d.patch.split('\n').length > 600 ? h('div', { class: 'hunk', text: '… diff cut short, open the branch for the rest' }) : null)),
  );
}

function refreshSheet() {
  const refs = S.sheet;
  const t = S.tickets.get(S.openId);
  if (!refs || !t) return;
  const col = S.columns.find((c) => c.id === t.column);
  const hasAgent = Boolean(col?.agent);

  refs.id.textContent = t.id;
  const [cls, text] = chipFor(t);
  refs.chip.className = `chip ${cls}`;
  refs.chip.textContent = text;
  refs.chip.hidden = !text;

  const note = t.statusNote && ['blocked', 'failed', 'approved'].includes(t.status) ? t.statusNote : '';
  refs.note.hidden = !note;
  refs.note.textContent = note;
  refs.note.classList.toggle('bad', t.status === 'failed');

  const btns = [];
  if (t.status === 'running' || t.status === 'queued') btns.push(h('button', { class: 'btn', text: 'Stop agent', onclick: () => run(() => api('POST', `/api/tickets/${t.id}/stop`)) }));
  if (hasAgent && t.status !== 'running') btns.push(h('button', { class: 'btn primary', text: t.status === 'idle' ? 'Run again' : 'Retry', onclick: () => run(() => api('POST', `/api/tickets/${t.id}/retry`)) }));
  if (t.status === 'approved') btns.push(h('button', { class: 'btn primary', text: 'Mark done', onclick: () => run(() => api('POST', `/api/tickets/${t.id}/move`, { column: 'done' })) }));
  refs.actions.replaceChildren(...btns);
  refs.actions.hidden = btns.length === 0;

  refs.feedback.hidden = !t.feedback;
  if (t.feedback) {
    const open = refs.feedback.open;
    refs.feedback.replaceChildren(h('summary', { text: `Feedback from ${t.feedback.from}` }), h('pre', { text: t.feedback.text }));
    refs.feedback.open = open;
  }

  refs.moves.replaceChildren(
    ...S.columns.map((c) => h('button', {
      class: 'move', text: c.title, 'aria-pressed': String(c.id === t.column),
      onclick: () => c.id !== t.column && run(() => api('POST', `/api/tickets/${t.id}/move`, { column: c.id })),
    })),
  );

  const sig = `${t.runs.length}:${t.runs.at(-1)?.outcome}`;
  if (refs.changesSig !== sig) {
    refs.changesSig = sig;
    loadChanges(t.id);
  }
  refs.runs.replaceChildren(
    ...(t.runs.length === 0 ? [h('p', { class: 'muted', text: 'No agent has worked on this yet.' })] : [...t.runs].reverse().map((r) =>
      h('div', { class: 'run' },
        h('span', { class: `chip ${r.outcome === 'running' ? 'running' : ['done', 'pass', 'approve'].includes(r.outcome) ? 'done' : ['error', 'fail', 'changes'].includes(r.outcome) ? 'failed' : ''}`, text: `${AGENT_NAME[r.stage]}: ${r.outcome}` }),
        h('span', { class: 'grow' }, r.summary ? h('small', { text: r.summary }) : null),
        h('span', { class: 'cost', text: `${dur(r.startedAt, r.endedAt)}${r.costUsd ? ` · ${money(r.costUsd)}` : ''}` })))),
  );

  refs.comments.replaceChildren(...t.comments.map((c) => h('div', { class: 'comment', text: c.text })));
  refs.comments.hidden = t.comments.length === 0;
  const sendBtns = [h('button', { class: 'btn', text: 'Add note', onclick: () => sendComment(false) })];
  if (hasAgent) sendBtns.push(h('button', { class: 'btn primary', text: 'Add note & re-run', onclick: () => sendComment(true) }));
  refs.commentBtns.replaceChildren(...sendBtns);

  const rows = [['Branch', t.branch || 'not created yet'], ['Spent', money(t.costUsd || 0)], ['Sent back', `${t.loops} time${t.loops === 1 ? '' : 's'}`], ['Created', ago(t.createdAt)], ['Updated', ago(t.updatedAt)]];
  refs.meta.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { class: k === 'Branch' ? 'mono' : '', text: v })]));
  armDelete(false);
}

async function saveEdits() {
  const refs = S.sheet;
  const t = await run(() => api('PATCH', `/api/tickets/${S.openId}`, { title: refs.title.value, description: refs.desc.value }));
  if (t) {
    refs.save.hidden = true;
    toast('Saved');
  }
}

async function sendComment(rerun) {
  const text = S.sheet.commentBox.value.trim();
  if (!text) return toast('Write something first');
  const ok = await run(() => api('POST', `/api/tickets/${S.openId}/comments`, { text, rerun }));
  if (ok) S.sheet.commentBox.value = '';
}

let deleteArmed = false;
function armDelete(on) {
  deleteArmed = on;
  const b = S.sheet?.delete;
  if (!b) return;
  b.classList.toggle('armed', on);
  b.textContent = on ? 'Tap again to delete' : 'Delete ticket';
}
async function onDelete() {
  if (!deleteArmed) {
    armDelete(true);
    setTimeout(() => armDelete(false), 3500);
    return;
  }
  const id = S.openId;
  closeSheet();
  await run(() => api('DELETE', `/api/tickets/${id}`));
}

// ---- new ticket / info / login -------------------------------------------------------------

function openNewTicket() {
  const title = h('input', { type: 'text', id: 'n-title', maxLength: 200, placeholder: 'e.g. Add dark mode toggle', required: true, autocomplete: 'off' });
  const desc = h('textarea', { id: 'n-desc', rows: 6, maxLength: 10000, placeholder: 'What should it do? How will we know it works?' });
  const create = (start) => async () => {
    if (!title.value.trim()) return title.focus();
    const t = await run(() => api('POST', '/api/tickets', { title: title.value, description: desc.value, start }));
    if (t) {
      closeSheet();
      goTab(start ? 'in_work' : 'backlog');
      toast(start ? `${t.id} started` : `${t.id} added to backlog`);
    }
  };
  S.openId = null;
  S.sheet = null;
  sheet().setAttribute('aria-labelledby', 'sheet-h');
  sheet().replaceChildren(
    h('div', { class: 'sheet-grab' }),
    h('div', { class: 'sheet-head' }, h('h2', { id: 'sheet-h', text: 'New ticket' }), h('span', { class: 'grow' }), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeSheet }, closeIcon())),
    h('div', { class: 'sheet-body' },
      h('div', { class: 'field' }, h('label', { for: 'n-title', text: 'Title' }), title),
      h('div', { class: 'field' }, h('label', { for: 'n-desc', text: 'Description' }), desc),
      h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Add to backlog', onclick: create(false) }), h('button', { class: 'btn primary', text: 'Add & start', onclick: create(true) })),
      h('p', { class: 'muted', text: '"Add & start" puts it straight into In Work and a developer agent begins.' })),
  );
  sheet().showModal();
  title.focus();
}

function openInfo() {
  const st = S.status;
  const rows = [
    ['Agents', { mock: 'Demo mode (simulated, free)', api: 'Claude via API key', subscription: 'Claude via your subscription' }[st.mode] || st.mode],
    ['Working now', `${st.running || 0} of ${st.maxConcurrent || 0}`],
    ['Queued', String(st.queued || 0)],
    [st.mode === 'subscription' ? 'Est. usage today' : 'Spent today', st.dailyBudgetUsd > 0 ? `${money(st.spentToday || 0)} of $${st.dailyBudgetUsd}` : money(st.spentToday || 0)],
    ['Base branch', S.workspace.base || ''],
    ['Pushes branches', S.workspace.pushes ? 'yes' : 'no (local only)'],
  ];
  S.openId = null;
  S.sheet = null;
  sheet().setAttribute('aria-labelledby', 'sheet-h');
  sheet().replaceChildren(
    h('div', { class: 'sheet-grab' }),
    h('div', { class: 'sheet-head' }, h('h2', { id: 'sheet-h', text: 'Status' }), h('span', { class: 'grow' }), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeSheet }, closeIcon())),
    h('div', { class: 'sheet-body' },
      st.mode === 'mock' ? h('div', { class: 'note', text: 'Demo mode: agents are simulated. Set ANTHROPIC_API_KEY on the server to use real Claude agents.' }) : null,
      h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      h('button', { class: 'btn', text: 'Sign out', onclick: async () => { closeSheet(); await run(() => api('POST', '/api/logout')); showLogin(); } })),
  );
  sheet().showModal();
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  closeSheet();
  es?.close();
  es = null;
  $('#pw').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    await api('POST', '/api/login', { password: $('#pw').value });
    $('#pw').value = '';
    await start();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
});

$('#fab').addEventListener('click', openNewTicket);
$('#info-btn').addEventListener('click', openInfo);
sheet().addEventListener('click', (e) => {
  if (e.target === sheet()) closeSheet(); // tap on the backdrop
});
sheet().addEventListener('close', () => {
  S.openId = null;
  S.sheet = null;
});

// ---- live updates --------------------------------------------------------------------------

let es = null;

function upsert(t) {
  const old = S.tickets.get(t.id);
  S.tickets.set(t.id, { ...old, ...t });
  if (t.logCount === 0) S.lastLog.delete(t.id);
  // Tell the user when something needs them, even if they are looking at another column.
  if (old && (old.status !== t.status || old.column !== t.column)) {
    if (t.status === 'blocked') toast(`${t.id} needs you: ${t.statusNote}`, 6000);
    else if (t.status === 'failed') toast(`${t.id} failed: ${t.statusNote}`, 6000);
    else if (t.status === 'approved') toast(`${t.id} approved. Ready for you to mark done.`, 6000);
    else if (t.column === 'done' && old.column !== 'done') toast(`${t.id} is done`);
  }
  scheduleRender();
}

async function loadBoard() {
  const b = await api('GET', '/api/board');
  S.columns = b.columns;
  S.status = b.status;
  S.workspace = b.workspace;
  S.tickets = new Map(b.tickets.map((t) => [t.id, t]));
  if (colEls.size !== S.columns.length) buildBoard();
  for (const t of b.tickets) if (t.lastLog) S.lastLog.set(t.id, t.lastLog);
  scheduleRender();
}

function connect() {
  es?.close();
  es = new EventSource('/api/events');
  es.onopen = async () => {
    S.conn = 'ok';
    await run(loadBoard); // catch up on anything missed while disconnected
    if (S.openId) {
      const full = await run(() => api('GET', `/api/tickets/${S.openId}`));
      if (full) {
        S.tickets.set(S.openId, full);
        S.sheet?.log.replaceChildren();
        for (const e of full.log) appendLog(e, true);
      }
    }
    scheduleRender();
  };
  es.onerror = async () => {
    S.conn = 'lost';
    scheduleRender();
    const s = await fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => null);
    if (s && s.authRequired && !s.authed) showLogin();
  };
  es.addEventListener('ticket', (e) => upsert(JSON.parse(e.data)));
  es.addEventListener('removed', (e) => {
    const { id } = JSON.parse(e.data);
    S.tickets.delete(id);
    S.lastLog.delete(id);
    if (S.openId === id) closeSheet();
    scheduleRender();
  });
  es.addEventListener('log', (e) => {
    const { id, entry } = JSON.parse(e.data);
    if (entry.kind === 'say' || entry.kind === 'tool') {
      const line = entry.text.split('\n')[0];
      S.lastLog.set(id, line);
      const live = cardEls.get(id)?.querySelector('.card-live');
      if (live && S.tickets.get(id)?.status === 'running') live.textContent = line;
      else scheduleRender();
    }
    if (S.openId === id) appendLog(entry);
  });
  es.addEventListener('status', (e) => {
    S.status = JSON.parse(e.data);
    scheduleRender();
  });
}

async function start() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  await run(loadBoard);
  if (!S.columns.length) return;
  goTab(S.tab, false);
  connect();
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const s = await fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => null);
  if (!s) {
    $('#login').hidden = false;
    $('#login-err').textContent = 'Cannot reach the server.';
    return;
  }
  if (s.authRequired && !s.authed) return showLogin();
  start();
}

// Relative times in the open sheet go stale; refresh them occasionally.
setInterval(() => S.openId && refreshSheet(), 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.columns.length && (!es || es.readyState === 2)) connect();
});

boot();
