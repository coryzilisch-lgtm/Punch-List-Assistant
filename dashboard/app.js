/**
 * Punch List Assistant — front end.
 *
 * Flow: pick a Procore project → upload the owner's PDF → each page is rendered
 * and read → review and correct the extracted items → push them to Procore.
 *
 * The review step is the point of the whole app. Everything before it is a draft
 * produced by a model reading a scan, and everything after it is a real write
 * into a live project. Nothing reaches Procore that a superintendent has not
 * looked at.
 */

import { loadPdf, processPage } from './pdf-pipeline.js';

const STEPS = ['project', 'upload', 'review', 'send'];

const S = {
  step: 'project',
  me: null,
  projects: [],
  project: null,
  config: null,
  fileName: null,
  pdf: null,
  pageStatus: [], // 'pending' | 'busy' | 'done' | 'skip' | 'fail'
  pageNotes: [],
  items: [],
  defaults: {
    punchItemTypeId: '',
    punchItemManagerId: '',
    finalApproverId: '',
    assigneeId: '',
    vendorId: '',
    priority: '',
    dueDate: '',
  },
  results: [],
  sending: false,
};

let nextItemId = 1;

// ── Utilities ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 400) };
  }
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (HTTP ${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function note(kind, html) {
  return `<div class="note ${kind}">${html}</div>`;
}

/**
 * Loosely match free text from the owner's document against the names Procore
 * actually has. Exact match first, then containment either way — "Kitchen"
 * should find "Kitchen", and "RR Hallway" should find "Restroom Hallway" only
 * if one literally contains the other. Deliberately conservative: a wrong
 * auto-selection is worse than an empty dropdown, because the super will scan
 * past a filled-in field and stop at an empty one.
 */
function matchByName(text, list) {
  if (!text || !list?.length) return null;
  const needle = String(text).trim().toLowerCase();
  if (!needle) return null;
  const exact = list.find((o) => o.name?.trim().toLowerCase() === needle);
  if (exact) return exact;
  const partial = list.find((o) => {
    const n = o.name?.trim().toLowerCase();
    return n && (n.includes(needle) || needle.includes(n));
  });
  return partial || null;
}

// ── Step navigation ─────────────────────────────────────────────────────────

function goto(step) {
  S.step = step;
  for (const p of STEPS) {
    $(`panel-${p}`).classList.toggle('active', p === step);
  }
  const idx = STEPS.indexOf(step);
  document.querySelectorAll('.step').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    el.classList.toggle('done', i < idx);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderBar();
}

function renderBar() {
  const back = $('back-btn');
  const next = $('next-btn');
  const dry = $('dryrun-btn');
  const summary = $('bar-summary');

  back.style.visibility = S.step === 'project' ? 'hidden' : 'visible';
  dry.style.display = 'none';
  next.style.display = 'inline-block';
  next.disabled = false;

  if (S.step === 'project') {
    next.textContent = 'Continue';
    next.disabled = !S.project;
    summary.textContent = S.project ? S.project.name : 'Choose a project to begin';
  } else if (S.step === 'upload') {
    const done = S.pageStatus.filter((s) => s === 'done' || s === 'skip').length;
    const total = S.pageStatus.length;
    next.textContent = 'Review items';
    next.disabled = S.items.length === 0;
    summary.innerHTML = total
      ? `<b>${S.items.length}</b> items found · ${done}/${total} pages read`
      : 'Upload a punch list PDF';
  } else if (S.step === 'review') {
    const n = S.items.filter((i) => i.include).length;
    next.textContent = 'Continue';
    next.disabled = n === 0;
    summary.innerHTML = `<b>${n}</b> of ${S.items.length} items selected`;
  } else {
    const n = S.items.filter((i) => i.include).length;
    dry.style.display = 'inline-block';
    next.textContent = S.sending ? 'Sending…' : `Create ${n} punch items`;
    next.disabled = S.sending || n === 0;
    summary.innerHTML = `Sending to <b>${esc(S.project?.name || '')}</b>`;
  }
}

// ── Step 1: project ─────────────────────────────────────────────────────────

async function loadProjects() {
  try {
    const data = await api('/api/projects');
    S.projects = data.projects || [];
    $('project-load').style.display = 'none';
    $('project-pick').style.display = 'block';
    $('project-search').placeholder = `Start typing — ${S.projects.length} projects`;
  } catch (err) {
    $('project-load').style.display = 'none';
    $('project-error').innerHTML = note(
      'error',
      `<strong>Couldn't load projects.</strong> ${esc(err.message)}`,
    );
  }
}

let comboIndex = -1;
let comboMatches = [];

/**
 * Filter projects for the type-ahead.
 *
 * Every term must appear somewhere in the project's searchable text, in any
 * order — so "durham long" finds "LongHorn Durham" and a job number typed on its
 * own still hits. Substring, not fuzzy: a superintendent typing a real project
 * name should never be beaten to the top by something that merely shares letters.
 */
function matchProjects(query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return S.projects.slice(0, 50);

  const scored = [];
  for (const p of S.projects) {
    const hay = `${p.name} ${p.number || ''} ${p.id} ${p.stage || ''}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    // Rank a name that starts with the query above one that merely contains it.
    const name = p.name.toLowerCase();
    const rank = name.startsWith(terms[0]) ? 0 : name.includes(terms[0]) ? 1 : 2;
    scored.push({ p, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.p.name.localeCompare(b.p.name));
  return scored.map((x) => x.p).slice(0, 50);
}

function highlight(text, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let out = esc(text);
  for (const t of terms) {
    // Escape the term for regex, and match against the already-escaped string.
    const safe = esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(${safe})`, 'ig'), '<mark>$1</mark>');
  }
  return out;
}

function renderProjectList(query) {
  const list = $('project-list');
  comboMatches = matchProjects(query);

  if (!comboMatches.length) {
    list.innerHTML = `<li class="combo-empty">No project matches “${esc(query)}”</li>`;
  } else {
    list.innerHTML = comboMatches
      .map((p, i) => {
        const sub = [p.number ? `#${esc(p.number)}` : '', esc(p.stage || '')]
          .filter(Boolean)
          .join(' · ');
        return `<li role="option" id="combo-opt-${i}" data-id="${p.id}" aria-selected="${
          i === comboIndex
        }">${highlight(p.name, query)}${sub ? `<span class="combo-sub">${sub}</span>` : ''}</li>`;
      })
      .join('');
  }
  openCombo(true);
}

function openCombo(open) {
  const list = $('project-list');
  list.hidden = !open;
  $('project-search').setAttribute('aria-expanded', String(open));
  if (!open) {
    comboIndex = -1;
    $('project-search').removeAttribute('aria-activedescendant');
  }
}

function moveCombo(delta) {
  if ($('project-list').hidden || !comboMatches.length) return;
  comboIndex = (comboIndex + delta + comboMatches.length) % comboMatches.length;
  const opts = $('project-list').querySelectorAll('li[role="option"]');
  opts.forEach((el, i) => el.setAttribute('aria-selected', String(i === comboIndex)));
  const active = opts[comboIndex];
  if (active) {
    active.scrollIntoView({ block: 'nearest' });
    $('project-search').setAttribute('aria-activedescendant', active.id);
  }
}

function chooseProject(id) {
  const project = S.projects.find((p) => p.id === Number(id));
  if (!project) return;
  $('project-search').value = project.name;
  $('project-clear').hidden = false;
  openCombo(false);
  selectProject(project.id);
}

function clearProject() {
  $('project-search').value = '';
  $('project-clear').hidden = true;
  $('project-chosen').textContent = '';
  S.project = null;
  S.config = null;
  $('readiness-card').style.display = 'none';
  openCombo(false);
  renderBar();
  $('project-search').focus();
}

async function selectProject(id) {
  S.project = S.projects.find((p) => p.id === Number(id)) || null;
  S.config = null;
  renderBar();
  if (!S.project) {
    $('readiness-card').style.display = 'none';
    return;
  }

  $('project-chosen').innerHTML =
    `Selected: <strong>${esc(S.project.name)}</strong>` +
    (S.project.number ? ` · #${esc(S.project.number)}` : '') +
    (S.project.stage ? ` · ${esc(S.project.stage)}` : '');
  $('readiness-card').style.display = 'block';
  $('readiness').innerHTML = '<div class="muted">Checking Procore access…</div>';

  // Config and probe are independent; run them together so the check is quick.
  const [config, probe] = await Promise.allSettled([
    api(`/api/projects/${S.project.id}/config`),
    api(`/api/probe?project_id=${S.project.id}`),
  ]);

  if (config.status === 'fulfilled') S.config = config.value;

  let html = '';
  if (probe.status === 'fulfilled') {
    html = probe.value.checks
      .map(
        (c) =>
          `<div class="result-row ${c.ok ? 'ok' : 'fail'}"><span class="ic">${
            c.ok ? '✓' : '✕'
          }</span><span><strong>${esc(c.name)}</strong><br><span class="muted">${esc(
            c.detail,
          )}</span></span></div>`,
      )
      .join('');
  } else {
    html = note('error', `Could not run the connection check. ${esc(probe.reason?.message || '')}`);
  }

  if (S.config?.warnings?.length) {
    html += note(
      'warn',
      `<strong>Some dropdowns will be empty.</strong> ${esc(S.config.warnings.join('; '))}`,
    );
  }

  $('readiness').innerHTML = html;
  renderBar();
}

// ── Step 2: upload and read ─────────────────────────────────────────────────

function wireDropzone() {
  const dz = $('dropzone');
  const input = $('file-input');

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    if (input.files?.[0]) handleFile(input.files[0]);
  });

  for (const evt of ['dragenter', 'dragover']) {
    dz.addEventListener(evt, (e) => {
      e.preventDefault();
      dz.classList.add('over');
    });
  }
  for (const evt of ['dragleave', 'drop']) {
    dz.addEventListener(evt, (e) => {
      e.preventDefault();
      dz.classList.remove('over');
    });
  }
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
}

async function handleFile(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    $('upload-status').innerHTML = note('error', 'That file is not a PDF.');
    return;
  }

  S.fileName = file.name;
  S.items = [];
  S.results = [];
  $('upload-status').innerHTML = `<div class="muted" style="margin-top:12px">Opening ${esc(file.name)}…</div>`;

  try {
    const buffer = await file.arrayBuffer();
    S.pdf = await loadPdf(buffer);
  } catch (err) {
    $('upload-status').innerHTML = note(
      'error',
      `<strong>Couldn't open that PDF.</strong> ${esc(err.message)}. If it opens in Preview or Acrobat, try re-saving it and upload again.`,
    );
    return;
  }

  const total = S.pdf.numPages;
  S.pageStatus = new Array(total).fill('pending');
  S.pageNotes = new Array(total).fill(null);

  $('upload-status').innerHTML = note(
    'ok',
    `<strong>${esc(file.name)}</strong> — ${total} page${total === 1 ? '' : 's'}.`,
  );
  $('reading-card').style.display = 'block';
  renderPageChips();

  await readAllPages();
}

/** Read every page, a few at a time. */
async function readAllPages() {
  const total = S.pdf.numPages;
  const queue = Array.from({ length: total }, (_, i) => i + 1);
  const CONCURRENCY = 3;

  const worker = async () => {
    while (queue.length) {
      const pageNumber = queue.shift();
      await readOnePage(pageNumber);
      renderPageChips();
      renderReadProgress();
      renderBar();
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  renderReadNotes();
}

async function readOnePage(pageNumber) {
  S.pageStatus[pageNumber - 1] = 'busy';
  renderPageChips();

  try {
    const rendered = await processPage(S.pdf, pageNumber);

    const result = await api('/api/extract', {
      method: 'POST',
      body: JSON.stringify({
        pageNumber,
        totalPages: S.pdf.numPages,
        image: rendered.pageImage,
        photos: rendered.photos.map((p) => ({
          index: p.index,
          top: p.top,
          bottom: p.bottom,
          left: p.left,
          right: p.right,
        })),
      }),
    });

    for (const raw of result.items || []) {
      S.items.push(toItem(raw, pageNumber, rendered.photos));
    }

    S.pageNotes[pageNumber - 1] = result.notes || null;
    S.pageStatus[pageNumber - 1] = (result.items || []).length ? 'done' : 'skip';
  } catch (err) {
    S.pageStatus[pageNumber - 1] = 'fail';
    S.pageNotes[pageNumber - 1] = err.message;
  }
}

/** Turn one extracted record into an editable review row. */
function toItem(raw, pageNumber, pagePhotos) {
  const locationMatch = matchByName(raw.location, S.config?.locations);
  const tradeMatch = matchByName(raw.trade_guess, S.config?.trades);

  return {
    id: nextItemId++,
    page: pageNumber,
    include: true,
    sourceNumber: raw.source_number || null,
    title: raw.title || '',
    description: raw.description || '',
    // Kept separately from the Procore ids so that nothing the owner wrote is
    // lost when it has no Procore equivalent — see buildDescription().
    sourceLocation: raw.location || '',
    sourceRoom: raw.room || '',
    sourceSheet: raw.sheet || '',
    sourceAssignee: raw.assignee || '',
    tradeGuess: raw.trade_guess || '',
    confidence: raw.confidence || 'medium',
    dueDate: raw.due_date || '',
    photos: (raw.photo_indexes || [])
      .map((idx) => pagePhotos.find((p) => p.index === idx)?.dataUrl)
      .filter(Boolean),
    // Every Procore field lives on the item. Nothing is a hidden default: what
    // the row shows is exactly what gets sent.
    punchItemTypeId: '',
    punchItemManagerId: '',
    finalApproverId: '',
    priority: '',
    locationId: locationMatch ? String(locationMatch.id) : '',
    tradeId: tradeMatch ? String(tradeMatch.id) : '',
    assigneeId: '',
    vendorId: '',
    priority: '',
  };
}

function renderPageChips() {
  $('page-chips').innerHTML = S.pageStatus
    .map((status, i) => {
      const cls = status === 'pending' ? '' : status;
      const label = status === 'fail' ? `${i + 1} ↻` : String(i + 1);
      const title =
        status === 'fail'
          ? 'Failed — click to try this page again'
          : status === 'skip'
            ? 'No punch items on this page'
            : '';
      return `<span class="page-chip ${cls}" data-page="${i + 1}" title="${esc(title)}">${label}</span>`;
    })
    .join('');
}

function renderReadProgress() {
  const total = S.pageStatus.length || 1;
  const done = S.pageStatus.filter((s) => s === 'done' || s === 'skip' || s === 'fail').length;
  $('read-progress').style.width = `${(done / total) * 100}%`;
  $('read-label').textContent =
    done < total
      ? `Read ${done} of ${total} pages · ${S.items.length} items so far`
      : `Finished. ${S.items.length} items found across ${total} pages.`;
}

function renderReadNotes() {
  const failed = S.pageStatus
    .map((s, i) => (s === 'fail' ? i + 1 : null))
    .filter(Boolean);
  const notes = S.pageNotes
    .map((n, i) => (n && S.pageStatus[i] !== 'fail' ? { page: i + 1, text: n } : null))
    .filter(Boolean);

  let html = '';
  if (failed.length) {
    html += note(
      'error',
      `<strong>${failed.length} page${failed.length === 1 ? '' : 's'} could not be read</strong> ` +
        `(${failed.join(', ')}). Click a red page number above to try again. ` +
        `Anything on those pages is missing from the list below.`,
    );
  }
  if (notes.length) {
    html += note(
      'warn',
      `<strong>Notes while reading:</strong><ul style="margin:6px 0 0;padding-left:20px">${notes
        .map((n) => `<li>Page ${n.page}: ${esc(n.text)}</li>`)
        .join('')}</ul>`,
    );
  }
  if (!failed.length && !notes.length && S.items.length) {
    html = note('ok', 'Every page read cleanly.');
  }
  $('read-notes').innerHTML = html;
}

// ── Step 3: review ──────────────────────────────────────────────────────────

function optionList(list, selected, blank) {
  return (
    `<option value="">${esc(blank)}</option>` +
    (list || [])
      .map(
        (o) =>
          `<option value="${o.id}" ${String(o.id) === String(selected) ? 'selected' : ''}>${esc(
            o.name,
          )}</option>`,
      )
      .join('')
  );
}

function renderDefaults() {
  const c = S.config || {};
  const d = S.defaults;
  const people = c.users || [];

  $('defaults').innerHTML = `
    <div class="grid-2">
      <div>
        <label class="fl" for="d-manager">Punch item manager</label>
        <select id="d-manager">${optionList(people, d.punchItemManagerId, '— None —')}</select>
      </div>
      <div>
        <label class="fl" for="d-approver">Final approver</label>
        <select id="d-approver">${optionList(people, d.finalApproverId, '— None —')}</select>
      </div>
      <div>
        <label class="fl" for="d-assignee">Assign to (person)</label>
        <select id="d-assignee">${optionList(people, d.assigneeId, '— None —')}</select>
      </div>
      <div>
        <label class="fl" for="d-vendor">Assign to (company)</label>
        <select id="d-vendor">${optionList(c.vendors, d.vendorId, '— None —')}</select>
      </div>
      <div>
        <label class="fl" for="d-type">Punch item type</label>
        <select id="d-type">${optionList(c.punchItemTypes, d.punchItemTypeId, '— None —')}</select>
      </div>
      <div>
        <label class="fl" for="d-priority">Priority</label>
        <select id="d-priority">
          <option value="">— None —</option>
          <option value="low" ${d.priority === 'low' ? 'selected' : ''}>Low</option>
          <option value="medium" ${d.priority === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="high" ${d.priority === 'high' ? 'selected' : ''}>High</option>
        </select>
      </div>
      <div>
        <label class="fl" for="d-due">Due date</label>
        <input type="date" id="d-due" value="${esc(d.dueDate)}" />
      </div>
    </div>
    <div class="apply-bar">
      <button class="btn-primary" id="apply-defaults">Apply to selected items</button>
      <span class="muted" id="apply-hint"></span>
    </div>
    ${
      people.length
        ? ''
        : note(
            'warn',
            'No project users came back from Procore, so the people dropdowns are empty. ' +
              'Procore usually requires a punch item manager and a final approver — without them the push may be rejected. ' +
              'Check that the service account can see this project\'s directory.',
          )
    }
  `;

  const bind = (id, key) => {
    $(id).addEventListener('change', (e) => {
      S.defaults[key] = e.target.value;
    });
  };
  bind('d-manager', 'punchItemManagerId');
  bind('d-approver', 'finalApproverId');
  bind('d-assignee', 'assigneeId');
  bind('d-vendor', 'vendorId');
  bind('d-type', 'punchItemTypeId');
  bind('d-priority', 'priority');
  bind('d-due', 'dueDate');
  $('apply-defaults').addEventListener('click', applyDefaults);
}

/**
 * Copy the bulk values onto every selected item.
 *
 * Deliberately an explicit action rather than a silent fallback at push time.
 * The old behaviour filled these in invisibly, so the review screen showed blank
 * fields while something else was sent — the reviewer was approving a row they
 * could not actually see. Now the only values that reach Procore are the ones
 * on screen.
 *
 * A blank bulk value is skipped rather than written, so pressing Apply never
 * wipes a choice already made on an individual row.
 */
function applyDefaults() {
  const d = S.defaults;
  const targets = S.items.filter((i) => i.include);
  if (!targets.length) {
    $('apply-hint').textContent = 'No items are selected.';
    return;
  }

  const fields = [
    ['punchItemTypeId', 'punchItemTypeId'],
    ['punchItemManagerId', 'punchItemManagerId'],
    ['finalApproverId', 'finalApproverId'],
    ['assigneeId', 'assigneeId'],
    ['vendorId', 'vendorId'],
    ['priority', 'priority'],
    ['dueDate', 'dueDate'],
  ];

  const applied = [];
  for (const [defKey, itemKey] of fields) {
    const value = d[defKey];
    if (!value) continue;
    for (const item of targets) item[itemKey] = value;
    applied.push(defKey);
  }

  renderItems();
  $('apply-hint').textContent = applied.length
    ? `Applied ${applied.length} field${applied.length === 1 ? '' : 's'} to ${targets.length} item${
        targets.length === 1 ? '' : 's'
      }.`
    : 'Nothing to apply — set a value above first.';
}

function visibleItems() {
  const q = ($('item-filter').value || '').trim().toLowerCase();
  if (!q) return S.items;
  return S.items.filter(
    (i) =>
      i.title.toLowerCase().includes(q) ||
      (i.sourceLocation || '').toLowerCase().includes(q) ||
      (i.description || '').toLowerCase().includes(q),
  );
}

function renderItems() {
  const list = visibleItems();
  const c = S.config || {};

  $('review-count').textContent = `${S.items.filter((i) => i.include).length} of ${S.items.length} selected`;

  $('items').innerHTML = list
    .map((item) => {
      const flagged = item.confidence === 'low';
      return `
      <div class="item ${item.include ? 'included' : 'excluded'} ${flagged ? 'low-conf' : ''}" data-id="${item.id}">
        <div class="pick">
          <input type="checkbox" data-act="include" ${item.include ? 'checked' : ''}
                 aria-label="Include this item" />
          <span class="srcnum">${item.sourceNumber ? `#${esc(item.sourceNumber)}` : ''}</span>
          <span class="srcnum">p${item.page}</span>
        </div>

        <div class="fields">
          <div>
            ${flagged ? '<span class="badge warn">Check this</span>' : ''}
            ${item.sourceAssignee ? `<span class="badge info">Assigned: ${esc(item.sourceAssignee)}</span>` : ''}
            ${item.tradeGuess ? `<span class="badge flat">Trade guess: ${esc(item.tradeGuess)}</span>` : ''}
          </div>
          <input class="title-input" type="text" data-act="title" value="${esc(item.title)}"
                 placeholder="What needs to be fixed" />
          <div class="subfields">
            <div>
              <label class="fl">Area (from document)</label>
              <input type="text" data-act="sourceLocation" value="${esc(item.sourceLocation)}" />
            </div>
            <div>
              <label class="fl">Procore location</label>
              <select data-act="locationId">${optionList(c.locations, item.locationId, '— Use area text —')}</select>
            </div>
            <div>
              <label class="fl">Trade</label>
              <select data-act="tradeId">${optionList(c.trades, item.tradeId, '— None —')}</select>
            </div>
            <div>
              <label class="fl">Type</label>
              <select data-act="punchItemTypeId">${optionList(
                c.punchItemTypes,
                item.punchItemTypeId,
                '— Use default —',
              )}</select>
            </div>
            <div>
              <label class="fl">Assign to (person)</label>
              <select data-act="assigneeId">${optionList(c.users, item.assigneeId, '— Use default —')}</select>
            </div>
            <div>
              <label class="fl">Assign to (company)</label>
              <select data-act="vendorId">${optionList(c.vendors, item.vendorId, '— Use default —')}</select>
            </div>
            <div>
              <label class="fl">Due date</label>
              <input type="date" data-act="dueDate" value="${esc(item.dueDate)}" />
            </div>
            <div>
              <label class="fl">Priority</label>
              <select data-act="priority">
                <option value="">— None —</option>
                <option value="low" ${item.priority === 'low' ? 'selected' : ''}>Low</option>
                <option value="medium" ${item.priority === 'medium' ? 'selected' : ''}>Medium</option>
                <option value="high" ${item.priority === 'high' ? 'selected' : ''}>High</option>
              </select>
            </div>
            <div>
              <label class="fl">Punch item manager</label>
              <select data-act="punchItemManagerId">${optionList(
                c.users,
                item.punchItemManagerId,
                '— None —',
              )}</select>
            </div>
            <div>
              <label class="fl">Final approver</label>
              <select data-act="finalApproverId">${optionList(
                c.users,
                item.finalApproverId,
                '— None —',
              )}</select>
            </div>
          </div>
          <div style="margin-top:9px">
            <label class="fl">Notes</label>
            <textarea data-act="description" placeholder="Optional detail">${esc(item.description)}</textarea>
          </div>
        </div>

        <div class="photos">
          ${
            item.photos.length
              ? item.photos
                  .map(
                    (src, i) =>
                      `<div class="photo"><img src="${src}" alt="Photo ${i + 1}" data-act="zoom" />` +
                      `<button data-act="rmphoto" data-idx="${i}" title="Remove this photo">×</button></div>`,
                  )
                  .join('')
              : '<span class="none">No photo</span>'
          }
        </div>
      </div>`;
    })
    .join('');
}

function wireItemDelegation() {
  const root = $('items');

  const findItem = (el) => {
    const wrapper = el.closest('.item');
    return wrapper ? S.items.find((i) => i.id === Number(wrapper.dataset.id)) : null;
  };

  root.addEventListener('input', (e) => {
    const act = e.target.dataset.act;
    const item = findItem(e.target);
    if (!item || !act) return;
    if (['title', 'description', 'sourceLocation', 'dueDate'].includes(act)) {
      item[act] = e.target.value;
    }
  });

  root.addEventListener('change', (e) => {
    const act = e.target.dataset.act;
    const item = findItem(e.target);
    if (!item || !act) return;

    if (act === 'include') {
      item.include = e.target.checked;
      e.target.closest('.item').classList.toggle('included', item.include);
      e.target.closest('.item').classList.toggle('excluded', !item.include);
      $('review-count').textContent = `${S.items.filter((i) => i.include).length} of ${S.items.length} selected`;
      renderBar();
      return;
    }
    if (
      [
        'locationId', 'tradeId', 'punchItemTypeId', 'assigneeId', 'vendorId',
        'punchItemManagerId', 'finalApproverId', 'priority',
      ].includes(act)
    ) {
      item[act] = e.target.value;
    }
  });

  root.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act === 'zoom') {
      $('lightbox-img').src = e.target.src;
      $('lightbox').classList.add('open');
      return;
    }
    if (act === 'rmphoto') {
      const item = findItem(e.target);
      if (!item) return;
      item.photos.splice(Number(e.target.dataset.idx), 1);
      renderItems();
    }
  });
}

// ── Step 4: send ────────────────────────────────────────────────────────────

/**
 * Compose the Procore description.
 *
 * Everything the owner wrote that has no Procore field of its own is appended
 * here rather than dropped. The area text is included only when it did not map
 * to a Procore location — if it mapped, the location field already carries it
 * and repeating it is noise. Getting this wrong in the other direction is the
 * expensive mistake: a sub who cannot tell which room the defect is in has to
 * call someone.
 */
function buildDescription(item) {
  const parts = [];
  if (item.description?.trim()) parts.push(item.description.trim());

  const context = [];
  if (item.sourceLocation && !item.locationId) context.push(`Area: ${item.sourceLocation}`);
  if (item.sourceRoom) context.push(`Room: ${item.sourceRoom}`);
  if (item.sourceSheet) context.push(`Sheet: ${item.sourceSheet}`);
  if (item.sourceAssignee) context.push(`Owner's list assigned to: ${item.sourceAssignee}`);
  if (context.length) parts.push(context.join('\n'));

  return parts.join('\n\n');
}

function buildReference(item) {
  const bits = [];
  if (S.fileName) bits.push(S.fileName.replace(/\.pdf$/i, ''));
  if (item.sourceNumber) bits.push(`Item ${item.sourceNumber}`);
  return bits.join(' · ').slice(0, 250) || null;
}

/**
 * Build the Procore payload from the row and nothing else.
 *
 * No fallback to the bulk values on purpose — those are copied onto the rows by
 * Apply, where the reviewer can see them. An invisible fallback here would mean
 * the screen and the payload could disagree, which is how the first run put
 * ball-in-court on the service account without anyone seeing why.
 */
function toPayload(item) {
  const num = (v) => (v ? Number(v) : null);

  return {
    clientId: String(item.id),
    name: item.title.trim(),
    description: buildDescription(item) || null,
    priority: item.priority || null,
    dueDate: item.dueDate || null,
    punchItemTypeId: num(item.punchItemTypeId),
    locationId: num(item.locationId),
    tradeId: num(item.tradeId),
    punchItemManagerId: num(item.punchItemManagerId),
    finalApproverId: num(item.finalApproverId),
    // No assignee means the item sits in nobody's court, which is the ask.
    assigneeIds: item.assigneeId ? [Number(item.assigneeId)] : [],
    vendorId: num(item.vendorId),
    reference: buildReference(item),
    photos: item.photos,
  };
}

function renderSendSummary() {
  const selected = S.items.filter((i) => i.include);
  const withPhotos = selected.filter((i) => i.photos.length).length;
  const photoCount = selected.reduce((n, i) => n + i.photos.length, 0);
  const missingTitle = selected.filter((i) => !i.title.trim()).length;

  let html = `
    <div class="grid-2" style="margin-bottom:14px">
      <div><label class="fl">Project</label>${esc(S.project?.name || '')}</div>
      <div><label class="fl">Items to create</label><strong>${selected.length}</strong></div>
      <div><label class="fl">Photos to attach</label>${photoCount} across ${withPhotos} items</div>
      <div><label class="fl">Source document</label>${esc(S.fileName || '—')}</div>
    </div>`;

  if (missingTitle) {
    html += note('error', `${missingTitle} selected item(s) have no text and will be skipped.`);
  }
  const missingRoles = selected.filter((i) => !i.punchItemManagerId || !i.finalApproverId).length;
  if (missingRoles) {
    html += note(
      'warn',
      `<strong>${missingRoles} item(s) have no punch item manager and/or final approver.</strong> ` +
        'Most Procore configurations require both. Set them in the bulk card on the review step and ' +
        'press <strong>Apply to selected items</strong>.',
    );
  }
  html += note(
    'info',
    'Send one item first if this is a new project — the result will tell you exactly what Procore requires ' +
      'before you commit the rest.',
  );

  $('send-summary').innerHTML = html;
}

async function doPush(dryRun) {
  const selected = S.items.filter((i) => i.include && i.title.trim());
  if (!selected.length) return;

  S.sending = true;
  renderBar();
  S.results = [];
  $('results-card').style.display = dryRun ? 'none' : 'block';
  $('dryrun-card').style.display = dryRun ? 'block' : 'none';
  $('results').innerHTML = '';

  const BATCH = dryRun ? 10 : 5;
  const batches = [];
  for (let i = 0; i < selected.length; i += BATCH) batches.push(selected.slice(i, i + BATCH));

  let done = 0;
  const payloads = [];

  for (const batch of batches) {
    $('send-progress').innerHTML =
      `<div class="progress-track"><div class="progress-fill" style="width:${
        (done / selected.length) * 100
      }%"></div></div><div class="muted">${done} of ${selected.length} processed…</div>`;

    try {
      const res = await api('/api/push', {
        method: 'POST',
        body: JSON.stringify({
          projectId: S.project.id,
          dryRun,
          // Dry runs never carry photo bytes — the payload preview only needs the count.
          items: batch.map((i) => {
            const p = toPayload(i);
            return dryRun ? { ...p, photos: [] } : p;
          }),
        }),
      });
      S.results.push(...res.results);
      if (dryRun) payloads.push(...res.results.map((r) => r.payload));
    } catch (err) {
      for (const item of batch) {
        S.results.push({ clientId: String(item.id), ok: false, error: err.message });
      }
    }

    done += batch.length;
    if (!dryRun) renderResults();
  }

  $('send-progress').innerHTML = '';
  S.sending = false;

  if (dryRun) {
    $('dryrun').textContent = JSON.stringify(payloads, null, 2);
  } else {
    renderResults();
    // Successfully created items are unchecked so a second press cannot create
    // duplicates — the most damaging mistake this tool could make, since a
    // duplicate punch item means two subs dispatched for one defect.
    for (const r of S.results) {
      if (r.ok) {
        const item = S.items.find((i) => String(i.id) === r.clientId);
        if (item) item.include = false;
      }
    }
    renderItems();
  }

  renderBar();
}

function renderResults() {
  const created = S.results.filter((r) => r.ok);
  const failed = S.results.filter((r) => !r.ok);

  let html = '';
  if (created.length) {
    html += note(
      'ok',
      `<strong>${created.length} punch item${created.length === 1 ? '' : 's'} created in Procore.</strong>`,
    );
  }
  if (failed.length) {
    html += note(
      'error',
      `<strong>${failed.length} item${failed.length === 1 ? '' : 's'} were rejected.</strong> ` +
        `They are still selected in the review step so you can fix and resend them.`,
    );
  }

  html += S.results
    .map((r) => {
      const item = S.items.find((i) => String(i.id) === r.clientId);
      const label = esc(item?.title || r.clientId);
      if (r.ok) {
        // Report what Procore stored, read back after the write — not what was
        // sent. A 200 is not evidence: the first production run returned 200 for
        // photos it silently discarded and assignments it silently ignored.
        const bits = [];

        const wanted = item?.photos.length || 0;
        if (wanted) {
          const got = r.photosAttached ?? 0;
          bits.push(
            got >= wanted
              ? `<span class="badge ok">${got} photo${got === 1 ? '' : 's'}</span>`
              : `<span class="badge err">${got}/${wanted} photos attached</span>` +
                  (r.photoErrors?.length
                    ? `<span class="muted"> ${esc(r.photoErrors.join('; '))}</span>`
                    : ''),
          );
        }

        const bic = r.observed?.ballInCourt || [];
        const wantedAssignee = Boolean(item?.assigneeId);
        if (bic.length) {
          bits.push(`<span class="badge info">Ball in court: ${esc(bic.join(', '))}</span>`);
        } else if (wantedAssignee) {
          bits.push('<span class="badge err">Assignee did not stick</span>');
        }
        if (r.assignErrors?.length) {
          bits.push(`<span class="muted">${esc(r.assignErrors.join('; '))}</span>`);
        }

        return `<div class="result-row ok"><span class="ic">✓</span><span>${label}${
          r.punchItemNumber ? ` <span class="muted">(#${esc(r.punchItemNumber)})</span>` : ''
        }${bits.length ? `<br>${bits.join(' ')}` : ''}</span></div>`;
      }
      const fields = r.fieldErrors?.length
        ? `<br><span class="muted">Procore said: ${esc(r.fieldErrors.join('; '))}</span>`
        : '';
      return `<div class="result-row fail"><span class="ic">✕</span><span>${label}<br><span class="muted">${esc(
        r.error || 'Failed',
      )}</span>${fields}</span></div>`;
    })
    .join('');

  $('results').innerHTML = html;
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function wire() {
  const search = $('project-search');
  search.addEventListener('input', (e) => {
    comboIndex = -1;
    $('project-clear').hidden = !e.target.value;
    renderProjectList(e.target.value);
  });
  search.addEventListener('focus', () => renderProjectList(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveCombo(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveCombo(-1); }
    else if (e.key === 'Enter') {
      // Enter with one match selects it even without arrowing — the common case
      // is typing enough to leave exactly one project.
      if (comboIndex >= 0) { e.preventDefault(); chooseProject(comboMatches[comboIndex].id); }
      else if (comboMatches.length === 1) { e.preventDefault(); chooseProject(comboMatches[0].id); }
    } else if (e.key === 'Escape') { openCombo(false); }
  });
  $('project-list').addEventListener('mousedown', (e) => {
    // mousedown, not click: blur would close the list before click landed.
    const li = e.target.closest('li[data-id]');
    if (li) { e.preventDefault(); chooseProject(li.dataset.id); }
  });
  $('project-clear').addEventListener('click', clearProject);
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.combo')) openCombo(false);
  });

  wireDropzone();
  wireItemDelegation();

  $('page-chips').addEventListener('click', async (e) => {
    const page = Number(e.target.dataset.page);
    if (!page || S.pageStatus[page - 1] !== 'fail') return;
    await readOnePage(page);
    renderPageChips();
    renderReadProgress();
    renderReadNotes();
    renderBar();
  });

  $('item-filter').addEventListener('input', renderItems);
  $('select-all').addEventListener('click', () => {
    for (const i of visibleItems()) i.include = true;
    renderItems();
    renderBar();
  });
  $('select-none').addEventListener('click', () => {
    for (const i of visibleItems()) i.include = false;
    renderItems();
    renderBar();
  });
  $('select-flagged').addEventListener('click', () => {
    for (const i of S.items) i.include = i.confidence === 'low';
    renderItems();
    renderBar();
  });

  $('lightbox').addEventListener('click', () => $('lightbox').classList.remove('open'));

  $('back-btn').addEventListener('click', () => {
    const i = STEPS.indexOf(S.step);
    if (i > 0) goto(STEPS[i - 1]);
  });

  $('next-btn').addEventListener('click', () => {
    if (S.step === 'project') goto('upload');
    else if (S.step === 'upload') {
      renderDefaults();
      renderItems();
      goto('review');
    } else if (S.step === 'review') {
      renderSendSummary();
      goto('send');
    } else {
      doPush(false);
    }
  });

  $('dryrun-btn').addEventListener('click', () => doPush(true));

  // A half-finished import is real work. Warn before it is thrown away.
  window.addEventListener('beforeunload', (e) => {
    if (S.items.some((i) => i.include)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

async function init() {
  wire();
  renderBar();

  try {
    S.me = await api('/api/me');
    $('who').textContent = S.me?.email || '';
  } catch {
    // Identity is for attribution only; the app still works without it.
  }

  await loadProjects();
}

init();
