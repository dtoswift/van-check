/*
 * Monthly vehicle checklist — client
 *
 * A static page: it runs entirely on the phone and needs no server, so it can
 * be hosted on GitHub Pages. Answers and photos are kept on the device
 * (autosaved so a reload or dropped signal loses nothing), photos are
 * compressed with <canvas>, the PDF is built with jsPDF, and the operative
 * shares it from the phone's share menu (email, WhatsApp, Teams and so on). Nothing is sent anywhere else.
 */
(function () {
  'use strict';

  const T = window.VAN_CHECK_TEMPLATE;
  if (!T || !Array.isArray(T.sections) || !window.jspdf) {
    const msg = document.createElement('p');
    msg.className = 'load-fail';
    msg.textContent = 'The checklist didn’t load. Check your signal and refresh the page.';
    document.body.replaceChildren(msg);
    return;
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  const CFG = {
    draftKey: 'vancheck:draft:v1',
    sessionKey: 'vancheck:session', // marks this browser tab's visit
    draftMaxAgeMs: 72 * 60 * 60 * 1000, // unfinished checks are discarded after 3 days
    maxPhotos: T.maxPhotos ?? 12,
    minPhotos: T.minPhotos ?? 1,
    imgMaxEdge: 1600, // px, longest side after compression
    imgQuality: 0.72, // JPEG quality
  };

  const LABELS = Object.assign({ driver: 'Driver', date: 'Date' }, T.labels);
  const FUEL_TYPES = T.fuelTypes || ['Diesel', 'Petrol', 'Electric'];
  const FLEET = (Array.isArray(T.vehicles) ? T.vehicles : []).filter((v) => v && v.reg)
    .map((v) => ({ reg: normReg(v.reg), make: String(v.make || '').trim(), fuel: v.fuel || '' }));
  const ADD = '__add';
  const MY_VEHICLES_KEY = 'vancheck:my-vehicles';
  const HEADER_FIELDS = T.headerFields || [];
  const QUESTIONS = [];
  T.sections.forEach((s) => s.questions.forEach((q) => QUESTIONS.push(q)));
  const SIG = T.signature || null;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const state = {
    answers: {},     // question id → value; `${id}__comments` → comment text
    photos: [],      // { id, blob, w, h, added, url, broken }
    signature: null, // PNG data URL
    pdf: null,       // { blob, name, pages, warnings }
    pdfFile: null,   // the same PDF as a File, ready for the share sheet
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const byId = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function prettyDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function normReg(r) { return String(r || '').toUpperCase().replace(/\s+/g, ' ').trim(); }
  const regKey = (r) => normReg(r).replace(/ /g, '');

  const isBlank = (v) => v == null || String(v).trim() === '';
  const kb = (bytes) => (bytes > 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB');

  let toastTimer;
  function toast(msg, kind) {
    const t = byId('toast');
    t.textContent = msg;
    t.className = 'toast' + (kind === 'info' ? ' is-info' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  // -------------------------------------------------------------------------
  // IndexedDB for photos (localStorage is too small for images)
  // -------------------------------------------------------------------------
  const idb = (() => {
    let dbp;
    function open() {
      if (!('indexedDB' in window)) return Promise.reject(new Error('no-idb'));
      dbp = dbp || new Promise((res, rej) => {
        const r = indexedDB.open('vancheck', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    function run(mode, fn) {
      return open().then((db) => new Promise((res, rej) => {
        const tx = db.transaction('photos', mode);
        const req = fn(tx.objectStore('photos'));
        tx.oncomplete = () => res(req && req.result);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      }));
    }
    return {
      put: (p) => run('readwrite', (s) => s.put({ id: p.id, blob: p.blob, w: p.w, h: p.h, added: p.added })),
      del: (id) => run('readwrite', (s) => s.delete(id)),
      all: () => run('readonly', (s) => s.getAll()),
      clear: () => run('readwrite', (s) => s.clear()),
    };
  })();

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function optionsFor(q) {
    switch (q.type) {
      case 'satisfactory': return [
        { value: 'Satisfactory', label: '√ Satisfactory' },
        { value: 'Defective', label: 'X Defective', cls: 'choice-defective' },
      ];
      case 'yesno': return ['Yes', 'No'].map((v) => ({ value: v, label: v }));
      case 'yesnona': return ['Yes', 'No', 'N/A'].map((v) => ({ value: v, label: v }));
      case 'select': return (q.options || []).map((v) => ({ value: v, label: v }));
      default: return null;
    }
  }

  function textInputFor(q, inputId, errId) {
    let input;
    if (q.type === 'textarea') {
      input = el('textarea', { id: inputId, rows: 4, maxlength: q.maxLength || 2000 });
    } else if (q.type === 'date') {
      input = el('input', { id: inputId, type: 'date' });
    } else if (q.type === 'number') {
      input = el('input', { id: inputId, type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: 12 });
    } else {
      input = el('input', {
        id: inputId, type: 'text', autocomplete: 'off', maxlength: q.maxLength || 200,
        autocapitalize: q.upper ? 'characters' : 'sentences', spellcheck: q.upper ? 'false' : null,
      });
    }
    input.setAttribute('aria-describedby', errId);
    input.addEventListener('input', () => {
      setAnswer(q.id, q.upper ? input.value.toUpperCase() : input.value);
    });
    if (q.upper) input.addEventListener('blur', () => { input.value = input.value.toUpperCase(); });
    return input;
  }

  // -------------------------------------------------------------------------
  // Vehicles: the company list from questions.js, plus any the operative adds
  // on this phone (kept in localStorage, so they're in the list next time).
  // -------------------------------------------------------------------------
  let myVehicles = [];
  function loadMyVehicles() {
    try { myVehicles = JSON.parse(localStorage.getItem(MY_VEHICLES_KEY) || '[]').filter((v) => v && v.reg); }
    catch (e) { myVehicles = []; }
  }
  function saveMyVehicles() {
    try { localStorage.setItem(MY_VEHICLES_KEY, JSON.stringify(myVehicles)); return true; } catch (e) { return false; }
  }
  function findVehicle(reg) {
    if (!reg) return null;
    const k = regKey(reg);
    const fleet = FLEET.find((v) => regKey(v.reg) === k);
    if (fleet) return fleet;
    const mine = myVehicles.find((v) => regKey(v.reg) === k);
    return mine ? Object.assign({ local: true }, mine) : null;
  }
  const vehicleLabel = (v) => [v.reg, v.make].filter(Boolean).join(' – ') + (v.fuel ? ` (${v.fuel})` : '');

  function populateVehicleSelect(selected) {
    const select = byId('in-vehicle-choice');
    const groups = [el('option', { value: '', text: 'Choose your van' })];
    if (FLEET.length) {
      groups.push(el('optgroup', { label: 'Company vehicles' },
        ...FLEET.map((v) => el('option', { value: v.reg, text: vehicleLabel(v) }))));
    }
    if (myVehicles.length) {
      groups.push(el('optgroup', { label: 'Added on this phone' },
        ...myVehicles.map((v) => el('option', { value: v.reg, text: vehicleLabel(v) }))));
    }
    groups.push(el('option', { value: ADD, text: '+ Add a vehicle that isn’t listed' }));
    select.replaceChildren(...groups);
    select.value = selected || '';
  }

  function fuelChoices(name) {
    return el('div', { class: 'choices' }, ...FUEL_TYPES.map((f) =>
      el('label', { class: 'choice' }, el('input', { type: 'radio', name, value: f }), el('span', { text: f }))));
  }

  function renderHeaderFields() {
    const box = byId('headerFields');
    loadMyVehicles();
    HEADER_FIELDS.forEach((q) => {
      const inputId = 'in-' + q.id;
      const errId = 'err-' + q.id;

      if (q.type === 'vehicle') {
        const select = el('select', { id: 'in-vehicle-choice', 'aria-describedby': errId });
        select.addEventListener('change', () => applyVehicleChoice(true));

        const addPanel = el('div', { class: 'followup', id: 'veh-add', hidden: true },
          el('p', { class: 'hint', text: 'Add your van here. It’s saved on this phone, so it will be in the list next time.' }),
          el('div', { class: 'field' },
            el('label', { for: 'add-reg', text: 'Registration' }),
            el('input', { id: 'add-reg', type: 'text', maxlength: 10, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' })),
          el('div', { class: 'field' },
            el('label', { for: 'add-make', text: 'Make/type' }),
            el('input', { id: 'add-make', type: 'text', maxlength: 60, autocomplete: 'off', autocapitalize: 'words' })),
          el('fieldset', { class: 'field' }, el('legend', { text: 'Fuel type' }), fuelChoices('add-fuel')),
          el('p', { class: 'err', id: 'err-veh-add' }),
          el('div', { class: 'stack' },
            el('button', { type: 'button', class: 'btn btn-primary', id: 'addVehBtn', text: 'Add this vehicle', onclick: onAddVehicle }),
            el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', onclick: () => { byId('in-vehicle-choice').value = ''; applyVehicleChoice(true); } })));

        box.append(el('div', { class: 'field', id: 'q-' + q.id },
          el('label', { for: 'in-vehicle-choice', text: q.text }),
          select,
          el('p', { class: 'err', id: errId }),
          addPanel,
          el('button', { type: 'button', class: 'btn btn-quiet', id: 'removeVehBtn', hidden: true, text: 'Remove this van from this phone', onclick: onRemoveVehicle })));
        populateVehicleSelect('');
        return;
      }

      // Filled in from the chosen vehicle; the operative can't edit it here.
      if (q.type === 'fromVehicle') {
        box.append(el('div', { class: 'field', id: 'q-' + q.id },
          el('label', { for: inputId, text: q.text }),
          el('input', { id: inputId, type: 'text', readonly: true, tabindex: '-1', placeholder: 'Filled in when you choose your van', 'aria-describedby': errId }),
          el('p', { class: 'err', id: errId })));
        return;
      }

      box.append(el('div', { class: 'field', id: 'q-' + q.id },
        el('label', { for: inputId, text: q.text }),
        textInputFor(q, inputId, errId),
        el('p', { class: 'err', id: errId })));
    });
  }

  // Copies the chosen vehicle into the answers, shows or hides the add panel,
  // and applies N/A to items that don't apply to that fuel type.
  // userChange = true when the operative changed it (not when restoring).
  function applyVehicleChoice(userChange) {
    const select = byId('in-vehicle-choice');
    if (!select) return;
    const choice = select.value;
    const adding = choice === ADD;
    const v = adding ? null : findVehicle(choice);

    byId('veh-add').hidden = !adding;
    byId('removeVehBtn').hidden = !(v && v.local);

    state.answers['vehicle-choice'] = v ? v.reg : '';
    state.answers['vehicle-reg'] = v ? v.reg : '';
    state.answers['vehicle-added'] = !!(v && v.local);
    HEADER_FIELDS.forEach((q) => {
      if (q.type !== 'fromVehicle') return;
      const val = v ? (v[q.from] || '') : '';
      state.answers[q.id] = val;
      byId('in-' + q.id).value = val;
    });

    applyNotApplicable();
    if (adding && userChange) byId('add-reg').focus();
    if (userChange) {
      clearError('vehicle-reg');
      updateProgress();
      scheduleSave();
    }
  }

  function onAddVehicle() {
    const reg = normReg(byId('add-reg').value);
    const make = byId('add-make').value.trim();
    const fuelInput = document.querySelector('input[name="add-fuel"]:checked');
    const fuel = fuelInput ? fuelInput.value : '';
    const err = byId('err-veh-add');

    let msg = '';
    if (!reg) msg = 'Enter the registration.';
    else if (!/^[A-Z0-9 ]{2,10}$/.test(reg)) msg = 'Use letters and numbers only for the registration, for example AB12 CDE.';
    else if (!make) msg = 'Enter the make and type, for example Ford Transit.';
    else if (!fuel) msg = 'Choose the fuel type.';
    if (msg) { err.textContent = msg; return; }
    err.textContent = '';

    const existing = findVehicle(reg);
    if (existing) {
      populateVehicleSelect(existing.reg);
      toast('That van is already in the list, so it’s been chosen for you.', 'info');
    } else {
      myVehicles.push({ reg, make, fuel });
      const saved = saveMyVehicles();
      populateVehicleSelect(reg);
      toast(saved ? 'Van added. It’s saved on this phone for next time.' : 'Van added for this check. This phone couldn’t save it for next time.', 'info');
    }
    byId('add-reg').value = '';
    byId('add-make').value = '';
    document.querySelectorAll('input[name="add-fuel"]').forEach((r) => { r.checked = false; });
    applyVehicleChoice(true);
  }

  function onRemoveVehicle() {
    const reg = byId('in-vehicle-choice').value;
    if (!window.confirm(`Remove ${reg} from the list on this phone?`)) return;
    myVehicles = myVehicles.filter((v) => regKey(v.reg) !== regKey(reg));
    saveMyVehicles();
    populateVehicleSelect('');
    applyVehicleChoice(true);
  }

  // Items with `naFor: ['Electric']` (etc.) are answered "N/A" automatically
  // and locked when the chosen vehicle has that fuel type.
  function applyNotApplicable() {
    const fuel = state.answers['fuel-type'] || '';
    QUESTIONS.forEach((q) => {
      if (!q.naFor) return;
      const wrap = byId('q-' + q.id);
      const note = byId('na-' + q.id);
      const toggle = byId('ct-' + q.id);
      const box = byId('cb-' + q.id);
      const radios = wrap.querySelectorAll('input[type="radio"]');
      const na = !!fuel && [].concat(q.naFor).includes(fuel);
      if (na) {
        state.answers[q.id] = 'N/A';
        state.answers[q.id + '__na'] = fuel;
        radios.forEach((r) => { r.checked = false; r.disabled = true; });
        wrap.classList.add('is-na');
        note.textContent = `Not applicable: ${fuel.toLowerCase()} vehicle`;
        note.hidden = false;
        if (toggle) toggle.hidden = true;
        if (box) box.hidden = true;
        clearError(q.id);
      } else {
        if (state.answers[q.id + '__na']) {
          delete state.answers[q.id];
          delete state.answers[q.id + '__na'];
        }
        radios.forEach((r) => { r.disabled = false; });
        wrap.classList.remove('is-na');
        note.hidden = true;
        if (toggle && box && box.hidden) toggle.hidden = false;
      }
    });
  }

  function renderQuestion(q, num) {
    const errId = 'err-' + q.id;
    const wrap = el('div', { class: 'q', id: 'q-' + q.id });
    const optional = q.required ? null : el('span', { class: 'optional', text: ' (optional)' });
    const numEl = num ? el('span', { class: 'qnum', text: num + '.' }) : null;
    const opts = optionsFor(q);

    if (opts) {
      const fs = el('fieldset', { 'aria-describedby': errId });
      fs.append(el('legend', {}, numEl, num ? ' ' : '', q.text, optional));
      const stacked = opts.length > 4 || opts.some((o) => o.label.length > 16);
      const box = el('div', { class: 'choices' + (stacked ? ' stacked' : '') });
      opts.forEach((o) => {
        box.append(el('label', { class: 'choice ' + (o.cls || '') },
          el('input', { type: 'radio', name: 'q-' + q.id, value: o.value, onchange: () => setAnswer(q.id, o.value) }),
          el('span', { text: o.label })));
      });
      fs.append(box);
      wrap.append(fs);
    } else {
      const inputId = 'in-' + q.id;
      wrap.append(el('label', { class: 'qlabel', for: inputId }, numEl, num ? ' ' : '', q.text, optional));
      wrap.append(textInputFor(q, inputId, errId));
    }
    if (q.help) wrap.append(el('p', { class: 'hint', text: q.help }));
    if (q.naFor) wrap.append(el('p', { class: 'na-note', id: 'na-' + q.id, hidden: true }));
    wrap.append(el('p', { class: 'err', id: errId }));

    if (q.comments) {
      const cId = 'in-' + q.id + '__comments';
      const box = el('div', { class: 'comment-box', id: 'cb-' + q.id, hidden: true },
        el('label', { for: cId, text: 'Comments' }),
        el('textarea', {
          id: cId, rows: 2, maxlength: 1000,
          oninput: (e) => setAnswer(q.id + '__comments', e.target.value),
        }));
      const toggle = el('button', {
        type: 'button', class: 'comment-toggle', id: 'ct-' + q.id, 'aria-controls': 'cb-' + q.id, 'aria-expanded': 'false',
        text: 'Add a comment',
        onclick: () => openComments(q.id, true),
      });
      wrap.append(toggle, box);
    }
    return wrap;
  }

  function openComments(id, focus) {
    const box = byId('cb-' + id);
    const t = byId('ct-' + id);
    if (!box) return;
    box.hidden = false;
    if (t) { t.hidden = true; t.setAttribute('aria-expanded', 'true'); }
    if (focus) byId('in-' + id + '__comments').focus();
  }

  function renderQuestions() {
    const host = byId('questions');
    let num = 0;
    T.sections.forEach((s) => {
      const block = el('section', { class: 'block' });
      if (s.title) block.append(el('h2', { class: 'section-title', text: s.title }));
      if (s.legend) block.append(el('p', { class: 'legend-key', text: [].concat(s.legend).join(', ') }));
      s.questions.forEach((q) => block.append(renderQuestion(q, s.title ? ++num : null)));
      host.append(block);
    });
  }

  // -------------------------------------------------------------------------
  // Answers, autosave, progress
  // -------------------------------------------------------------------------
  const isFlagged = (q) => q.flagIf != null && [].concat(q.flagIf).includes(state.answers[q.id]);

  function setAnswer(id, value) {
    state.answers[id] = value;
    clearError(id);
    const q = QUESTIONS.find((x) => x.id === id);
    if (q && q.comments && isFlagged(q)) openComments(q.id, false);
    updateProgress();
    scheduleSave();
  }

  function detailValues() {
    return {
      name: byId('opName').value.trim(),
      date: byId('checkDate').value,
    };
  }

  let saveTimer;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 400);
  }

  function saveDraft() {
    try {
      localStorage.setItem(CFG.draftKey, JSON.stringify({
        savedAt: Date.now(),
        details: detailValues(),
        answers: state.answers,
        signature: state.signature,
      }));
    } catch (e) { /* storage full or blocked: the form still works, it just won't survive a reload */ }
  }

  async function clearDraft() {
    try { localStorage.removeItem(CFG.draftKey); } catch (e) { /* ignore */ }
    try { await idb.clear(); } catch (e) { /* ignore */ }
  }

  function progressItems() {
    const items = [];
    const d = detailValues();
    HEADER_FIELDS.forEach((q) => { if (q.required && q.type !== 'fromVehicle') items.push(!isBlank(state.answers[q.id])); });
    items.push(!!d.name, !!d.date);
    QUESTIONS.forEach((q) => { if (q.required) items.push(!isBlank(state.answers[q.id])); });
    if (CFG.minPhotos > 0) items.push(state.photos.filter((p) => !p.broken).length >= CFG.minPhotos);
    if (SIG && SIG.required) items.push(!!state.signature);
    return items;
  }

  function updateProgress() {
    const items = progressItems();
    const done = items.filter(Boolean).length;
    byId('progressText').textContent = done === items.length
      ? 'All done. Ready to create the PDF.'
      : `${done} of ${items.length} done`;
    if (done === items.length) byId('toast').hidden = true;
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------
  function containerFor(id) {
    return byId('q-' + id) || byId('field-' + id);
  }

  function setError(id, msg) {
    const p = byId('err-' + id);
    if (p) p.textContent = msg;
    const c = containerFor(id);
    if (c) c.classList.add('has-error');
  }

  function clearError(id) {
    const p = byId('err-' + id);
    if (p) p.textContent = '';
    const c = containerFor(id);
    if (c) c.classList.remove('has-error');
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------
  function validate() {
    const problems = []; // [id, message]
    const d = detailValues();

    HEADER_FIELDS.forEach((q) => validateQuestion(q, problems));
    if (!d.name) problems.push(['opName', 'Enter your full name.']);
    if (!d.date) problems.push(['checkDate', 'Enter the date of the check.']);
    else if (d.date > todayISO()) problems.push(['checkDate', 'The date can’t be in the future.']);

    QUESTIONS.forEach((q) => validateQuestion(q, problems));

    const good = state.photos.filter((p) => !p.broken);
    const broken = state.photos.filter((p) => p.broken);
    if (broken.length) {
      problems.push(['photos', `${broken.length === 1 ? 'One photo' : broken.length + ' photos'} can’t be shown. Remove ${broken.length === 1 ? 'it' : 'them'} and add ${broken.length === 1 ? 'it' : 'them'} again.`]);
    } else if (good.length < CFG.minPhotos) {
      problems.push(['photos', CFG.minPhotos === 1 ? 'Add at least one photo of the van.' : `Add at least ${CFG.minPhotos} photos of the van.`]);
    }

    if (SIG && SIG.required && !state.signature) problems.push(['signature', 'Sign in the box.']);

    // Clear everything first, then mark what's wrong.
    document.querySelectorAll('.has-error').forEach((n) => n.classList.remove('has-error'));
    document.querySelectorAll('.err').forEach((n) => { if (!n.closest('.photo')) n.textContent = ''; });
    problems.forEach(([id, msg]) => setError(id, msg));
    return problems;
  }

  function validateQuestion(q, problems) {
    const v = state.answers[q.id];
    if (q.type === 'fromVehicle') return; // covered by the vehicle choice
    if (q.type === 'vehicle' && isBlank(v)) {
      const adding = byId('in-vehicle-choice') && byId('in-vehicle-choice').value === ADD;
      problems.push([q.id, adding
        ? 'Finish adding your van and tap “Add this vehicle”, or choose one from the list.'
        : 'Choose your van from the list, or add it if it isn’t there.']);
      return;
    }
    if (isBlank(v)) {
      if (q.required) problems.push([q.id, optionsFor(q) ? 'Choose an answer.' : 'Enter an answer.']);
      return;
    }
    if (q.type === 'number' && !/^\d[\d,]*(\.\d+)?$/.test(String(v).trim())) {
      problems.push([q.id, 'Enter a number using digits only, for example 45210.']);
    }
  }

  // -------------------------------------------------------------------------
  // Photos: decode, compress, keep
  // -------------------------------------------------------------------------
  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall back */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      const timer = setTimeout(() => { done(); reject(new Error('timeout')); }, 20000);
      function done() { clearTimeout(timer); URL.revokeObjectURL(url); }
      img.onload = () => { done(); resolve(img); };
      img.onerror = () => { done(); reject(new Error('decode')); };
      img.src = url;
    });
  }

  async function compressImage(file) {
    const src = await decodeImage(file);
    const sw = src.naturalWidth || src.width;
    const sh = src.naturalHeight || src.height;
    if (!sw || !sh) throw new Error('empty');
    const scale = Math.min(1, CFG.imgMaxEdge / Math.max(sw, sh));
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    if (src.close) src.close();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', CFG.imgQuality));
    c.width = 0; c.height = 0; // free memory on iOS
    if (!blob || blob.size < 100) throw new Error('encode');
    return { blob, w, h };
  }

  function setPhotoStatus(msg, kind) {
    const s = byId('photoStatus');
    s.textContent = msg || '';
    s.className = 'status' + (kind === 'error' ? ' is-error' : '');
  }

  async function addFiles(input) {
    const files = Array.from(input.files || []);
    input.value = ''; // allow choosing the same photo again
    if (!files.length) return;

    const room = CFG.maxPhotos - state.photos.length;
    if (room <= 0) {
      setPhotoStatus(`You’ve reached the limit of ${CFG.maxPhotos} photos. Remove one to add another.`, 'error');
      return;
    }
    const batch = files.slice(0, room);
    const skipped = files.length - batch.length;
    const failed = [];

    for (let i = 0; i < batch.length; i++) {
      setPhotoStatus(batch.length > 1 ? `Preparing photo ${i + 1} of ${batch.length}…` : 'Preparing photo…');
      try {
        const { blob, w, h } = await compressImage(batch[i]);
        const p = { id: uid(), blob, w, h, added: Date.now() };
        state.photos.push(p);
        renderPhotos();
        idb.put(p).catch(() => {});
      } catch (e) {
        failed.push(batch[i].name || 'photo');
      }
    }

    const msgs = [];
    if (failed.length) {
      msgs.push(`${failed.length === 1 ? 'One photo' : failed.length + ' photos'} couldn’t be opened. Take ${failed.length === 1 ? 'it' : 'them'} again, or choose a different photo.`);
    }
    if (skipped > 0) msgs.push(`${skipped} more ${skipped === 1 ? 'photo wasn’t' : 'photos weren’t'} added because the limit is ${CFG.maxPhotos}.`);
    setPhotoStatus(msgs.join(' '), msgs.length ? 'error' : null);

    if (state.photos.length) clearError('photos');
    updateProgress();
    scheduleSave();
  }

  function removePhoto(id) {
    const i = state.photos.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [p] = state.photos.splice(i, 1);
    if (p.url) URL.revokeObjectURL(p.url);
    idb.del(id).catch(() => {});
    renderPhotos();
    setPhotoStatus('Photo removed.');
    updateProgress();
  }

  function renderPhotos() {
    const list = byId('photoList');
    list.replaceChildren(...state.photos.map((p, i) => {
      p.url = p.url || URL.createObjectURL(p.blob);
      const img = el('img', { src: p.url, alt: `Van photo ${i + 1}` });
      const li = el('li', { class: 'photo' + (p.broken ? ' broken' : '') }, img);
      if (p.broken) li.append(el('p', { class: 'err', text: 'This photo can’t be shown. Remove it and add it again.' }));
      li.append(el('button', {
        type: 'button', class: 'photo-remove', 'aria-label': `Remove photo ${i + 1}`, text: 'Remove',
        onclick: () => removePhoto(p.id),
      }));
      img.addEventListener('error', () => {
        if (p.broken) return;
        p.broken = true;
        renderPhotos();
        updateProgress();
      });
      return li;
    }));
    byId('photoCount').textContent = `${state.photos.length} of ${CFG.maxPhotos}`;
  }

  // -------------------------------------------------------------------------
  // Signature pad
  // -------------------------------------------------------------------------
  const sig = (() => {
    const canvas = byId('sigPad');
    const ctx = canvas.getContext('2d');
    let drawing = false;
    let inked = false;
    let last = null;

    function size() {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      const w = Math.round(rect.width * ratio);
      const h = Math.round(rect.height * ratio);
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w; canvas.height = h;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      paintBackground();
      if (state.signature) drawFromData(state.signature);
    }

    function paintBackground() {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    function drawFromData(data) {
      const img = new Image();
      img.onload = () => {
        const rect = canvas.getBoundingClientRect();
        ctx.drawImage(img, 0, 0, rect.width, rect.height);
        inked = true;
      };
      img.src = data;
    }

    function point(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      drawing = true;
      last = point(e);
      ctx.beginPath();
      ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = '#111';
      ctx.fill();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      e.preventDefault();
      const p = point(e);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      inked = true;
    });
    const end = () => {
      if (!drawing) return;
      drawing = false;
      if (inked) {
        state.signature = canvas.toDataURL('image/png');
        clearError('signature');
        updateProgress();
        scheduleSave();
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    byId('sigClearBtn').addEventListener('click', () => {
      paintBackground();
      inked = false;
      state.signature = null;
      updateProgress();
      scheduleSave();
    });

    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(size, 150); });
    return { size };
  })();

  // -------------------------------------------------------------------------
  // Restore an unfinished check
  // -------------------------------------------------------------------------
  async function restoreDraft() {
    // A new visit (new tab, or the page opened again from a link or bookmark)
    // always starts with a blank form. Within the same visit, a refresh or the
    // phone reloading the page in the background brings the answers back.
    let newVisit = true;
    try {
      newVisit = !sessionStorage.getItem(CFG.sessionKey);
      sessionStorage.setItem(CFG.sessionKey, '1');
    } catch (e) { newVisit = true; }
    if (newVisit) {
      await clearDraft();
      return;
    }

    let d = null;
    try { d = JSON.parse(localStorage.getItem(CFG.draftKey) || 'null'); } catch (e) { d = null; }
    if (d && Date.now() - d.savedAt > CFG.draftMaxAgeMs) {
      await clearDraft();
      return;
    }
    let photos = [];
    try { photos = (await idb.all()) || []; } catch (e) { photos = []; }
    if (!d && !photos.length) return;

    if (d) {
      state.answers = d.answers || {};
      state.signature = d.signature || null;
      const det = d.details || {};
      byId('opName').value = det.name || '';
      if (det.date) byId('checkDate').value = det.date;

      for (const [id, v] of Object.entries(state.answers)) {
        const radio = document.querySelector(`input[name="q-${CSS.escape(id)}"][value="${CSS.escape(v)}"]`);
        if (radio) { radio.checked = true; continue; }
        const input = byId('in-' + id);
        if (input) input.value = v;
        if (id.endsWith('__comments') && !isBlank(v)) openComments(id.replace(/__comments$/, ''), false);
      }
      QUESTIONS.forEach((q) => { if (q.comments && isFlagged(q)) openComments(q.id, false); });
      applyVehicleChoice(false);
    }

    state.photos = photos.sort((a, b) => a.added - b.added);
    renderPhotos();

    const when = d ? new Date(d.savedAt) : null;
    byId('restoreText').textContent = when
      ? `Your answers from ${pad(when.getHours())}:${pad(when.getMinutes())} have been brought back after the page reloaded.`
      : 'Your unfinished check has been restored.';
    byId('restoreBanner').hidden = false;
  }

  // -------------------------------------------------------------------------
  // PDF
  // -------------------------------------------------------------------------
  // jsPDF's built-in Helvetica covers Latin-1 only; normalise anything else.
  function pdfSafe(s) {
    return String(s ?? '')
      .replace(/[\u2018\u2019\u2032]/g, "'")
      .replace(/[\u201C\u201D\u2033]/g, '"')
      .replace(/[\u2013\u2014\u2212]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u221A/g, 'v')
      .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
  }

  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function loadLogo() {
    if (!T.logo) return null;
    try {
      const res = await fetch(T.logo, { cache: 'force-cache' });
      if (!res.ok) return null;
      const blob = await res.blob();
      const url = await blobToDataURL(blob);
      const dims = await new Promise((r) => {
        const i = new Image();
        i.onload = () => r({ w: i.naturalWidth, h: i.naturalHeight });
        i.onerror = () => r(null);
        i.src = url;
      });
      return dims ? { url, ...dims } : null;
    } catch (e) { return null; }
  }

  function formatAnswer(q) {
    const v = state.answers[q.id];
    if (isBlank(v)) return '';
    if (q.type === 'date') return prettyDate(v);
    if (q.type === 'number') return String(v).trim() + (q.unit ? ' ' + q.unit : '');
    return String(v).trim();
  }

  async function buildPdf() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    doc.setLineHeightFactor(1.25);

    const PW = 210, PH = 297, M = 15, CW = PW - 2 * M, FOOT = 14;
    const C = {
      ink: [31, 42, 51], muted: [85, 99, 110], line: [170, 180, 188], head: [217, 217, 217],
      fail: [179, 38, 30], failBg: [252, 235, 234], panel: [242, 244, 246], hivis: [242, 194, 48],
    };
    const d = detailValues();
    const warnings = [];
    const submitted = new Date();
    let y = M;

    const lh = (pt) => pt * 0.3528 * 1.25;
    const font = (size, style = 'normal', color = C.ink) => {
      doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color);
    };
    const split = (text, width, size, style) => { font(size, style); return doc.splitTextToSize(pdfSafe(text), width); };
    const bottom = PH - M - FOOT;
    const ensure = (h) => { if (y + h > bottom) { doc.addPage(); y = M; return true; } return false; };
    const textAt = (lines, x, top, size) => doc.text(lines, x, top + size * 0.3528 * 0.85);

    // ---- Header: logo, title, hi-vis rule
    const logo = await loadLogo();
    if (logo) {
      const lh_ = 16, lw = lh_ * (logo.w / logo.h);
      try { doc.addImage(logo.url, 'JPEG', M - 2, y - 3, lw, lh_); } catch (e) { /* logo is decorative */ }
    }
    font(15, 'bold');
    doc.text(pdfSafe(T.title || 'Monthly vehicle checklist'), PW - M, y + 6, { align: 'right' });
    y += 16;
    doc.setFillColor(...C.hivis);
    doc.rect(M, y, CW, 1.6, 'F');
    y += 6;

    // ---- Details panel (mirrors the form's header lines)
    const detailRows = [
      ...HEADER_FIELDS.map((q) => [q.text, formatAnswer(q) || '-']),
      [LABELS.driver, d.name],
      [LABELS.date, prettyDate(d.date)],
    ];
    const half = (CW - 8) / 2;
    const rowsPerCol = Math.ceil(detailRows.length / 2);
    const panelH = rowsPerCol * 11 + 6;
    doc.setFillColor(...C.panel);
    doc.rect(M, y, CW, panelH, 'F');
    detailRows.forEach(([label, value], i) => {
      const col = i < rowsPerCol ? 0 : 1;
      const row = col ? i - rowsPerCol : i;
      const x = M + 4 + col * (half + 4);
      const top = y + 4 + row * 11;
      font(8, 'normal', C.muted); textAt(pdfSafe(label), x, top, 8);
      font(11, 'bold'); textAt(doc.splitTextToSize(pdfSafe(value), half - 4)[0] || '', x, top + 4, 11);
    });
    y += panelH + 3;
    font(8, 'normal', C.muted);
    textAt(pdfSafe(`Submitted ${submitted.toLocaleDateString('en-GB')} at ${pad(submitted.getHours())}:${pad(submitted.getMinutes())} from the van check page. ${state.photos.length} photo${state.photos.length === 1 ? '' : 's'} attached.${state.answers['vehicle-added'] ? ' Vehicle added by the driver (not on the company list).' : ''}`), M, y, 8);
    y += 7;

    // ---- Needs attention summary
    const flagged = QUESTIONS.filter(isFlagged);
    if (flagged.length) {
      const items = flagged.map((q) => {
        const c = state.answers[q.id + '__comments'];
        return `${q.text}: ${state.answers[q.id]}${isBlank(c) ? '' : ' - ' + c.trim()}`;
      });
      const lines = items.flatMap((t) => split('- ' + t, CW - 10, 10, 'normal'));
      const h = 9 + lines.length * lh(10) + 4;
      ensure(h);
      doc.setFillColor(...C.failBg);
      doc.rect(M, y, CW, h, 'F');
      doc.setFillColor(...C.fail);
      doc.rect(M, y, 1.6, h, 'F');
      font(11, 'bold', C.fail);
      textAt(`Needs attention (${flagged.length})`, M + 5, y + 3, 11);
      font(10, 'normal', C.ink);
      textAt(lines, M + 5, y + 9, 10);
      y += h + 6;
    } else {
      font(10, 'bold', [30, 122, 70]);
      textAt('No defects reported. No service or MOT flagged.', M, y, 10);
      y += 9;
    }

    // ---- Checklist tables, one per section, laid out like the paper form
    const colItem = 82, colRes = 32, colCom = CW - colItem - colRes;
    const PADX = 2, PADY = 1.8;

    // Column key, one line per entry as on the paper form. A leading √ is drawn
    // with the ZapfDingbats tick because Helvetica has no √ glyph.
    function drawLegend(legend, x, top) {
      [].concat(legend || 'Answer').forEach((line, i) => {
        const ly = top + i * lh(8);
        let tx = x;
        if (line.startsWith('√')) {
          doc.setFont('ZapfDingbats', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.ink);
          textAt('4', x, ly, 8); // ZapfDingbats "4" = check mark
          tx = x + doc.getTextWidth('4') + 0.4;
          line = line.slice(1);
        }
        font(8, 'normal'); textAt(pdfSafe(line), tx, ly, 8);
      });
    }

    function tableHeader(legend) {
      const legendCount = [].concat(legend || 'Answer').length;
      const h = Math.max(lh(9), legendCount * lh(8)) + 2 * PADY;
      doc.setFillColor(...C.head);
      doc.rect(M, y, CW, h, 'F');
      doc.setDrawColor(...C.line); doc.setLineWidth(0.2);
      doc.rect(M, y, CW, h);
      doc.line(M + colItem, y, M + colItem, y + h);
      doc.line(M + colItem + colRes, y, M + colItem + colRes, y + h);
      font(9, 'bold'); textAt('Item', M + PADX, y + PADY, 9);
      drawLegend(legend, M + colItem + PADX, y + PADY);
      font(9, 'bold'); textAt('Comments', M + colItem + colRes + PADX, y + PADY, 9);
      y += h;
    }

    let num = 0;
    for (const s of T.sections) {
      const tableQs = s.questions.filter((q) => optionsFor(q));
      const otherQs = s.questions.filter((q) => !optionsFor(q));

      if (s.title && tableQs.length) {
        ensure(26);
        font(11, 'bold'); textAt(pdfSafe(s.title), M, y, 11);
        y += 6.5;
        tableHeader(s.legend);

        for (const q of tableQs) {
          num++;
          const flaggedRow = isFlagged(q);
          const ans = formatAnswer(q) || 'Not answered';
          const itemLines = split(`${num}. ${q.text}`, colItem - 2 * PADX, 9.5, 'normal');
          const resLines = split(ans, colRes - 2 * PADX, 9.5, 'bold');
          const naFuel = state.answers[q.id + '__na'];
          const com = naFuel ? `Not applicable: ${naFuel.toLowerCase()} vehicle` : state.answers[q.id + '__comments'];
          const comLines = isBlank(com) ? [] : split(com.trim(), colCom - 2 * PADX, 9, 'normal');
          const h = Math.max(itemLines.length * lh(9.5), resLines.length * lh(9.5), comLines.length * lh(9), lh(9.5)) + 2 * PADY;

          if (ensure(h)) { // continue the table on a new page
            font(9, 'normal', C.muted); textAt(pdfSafe(`${s.title} (continued)`), M, y, 9); y += 5.5;
            tableHeader(s.legend);
          }
          if (flaggedRow) {
            doc.setFillColor(...C.failBg);
            doc.rect(M, y, CW, h, 'F');
          }
          doc.setDrawColor(...C.line); doc.setLineWidth(0.2);
          doc.rect(M, y, CW, h);
          doc.line(M + colItem, y, M + colItem, y + h);
          doc.line(M + colItem + colRes, y, M + colItem + colRes, y + h);

          font(9.5, 'normal'); textAt(itemLines, M + PADX, y + PADY, 9.5);
          font(9.5, 'bold', flaggedRow ? C.fail : (isBlank(state.answers[q.id]) || state.answers[q.id + '__na']) ? C.muted : C.ink);
          textAt(resLines, M + colItem + PADX, y + PADY, 9.5);
          if (comLines.length) { font(9, 'normal'); textAt(comLines, M + colItem + colRes + PADX, y + PADY, 9); }
          y += h;
        }
        y += 7;
      }

      // Free-text items (e.g. "Any other Information"), drawn as a box like the form
      for (const q of otherQs) {
        const v = formatAnswer(q);
        const lines = split(v || 'Nothing added.', CW - 6, 10, 'normal');
        ensure(Math.min(8 + lines.length * lh(10) + 6, 60));
        font(11, 'bold'); textAt(pdfSafe(q.text), M, y, 11);
        y += 6.5;
        // Write line by line so long text can run across pages.
        let boxTop = y;
        y += 3;
        font(10, 'normal', v ? C.ink : C.muted);
        for (const line of lines) {
          if (y + lh(10) > bottom) {
            doc.setDrawColor(...C.line); doc.rect(M, boxTop, CW, y - boxTop + 2);
            doc.addPage(); y = M; boxTop = y; y += 3;
            font(10, 'normal', v ? C.ink : C.muted);
          }
          textAt(line, M + 3, y, 10);
          y += lh(10);
        }
        y += 3;
        doc.setDrawColor(...C.line); doc.setLineWidth(0.2);
        doc.rect(M, boxTop, CW, Math.max(y - boxTop, 14));
        y = Math.max(y, boxTop + 14) + 7;
      }
    }

    // ---- Signature
    if (SIG) {
      ensure(40);
      font(11, 'bold'); textAt(pdfSafe(SIG.text), M, y, 11);
      y += 6;
      if (state.signature) {
        const sw = 75, sh = 26;
        try { doc.addImage(state.signature, 'PNG', M, y, sw, sh); } catch (e) { warnings.push('The signature couldn’t be added to the PDF. Clear it and sign again.'); }
        doc.setDrawColor(...C.ink); doc.setLineWidth(0.3);
        doc.line(M, y + sh, M + sw, y + sh);
        font(8, 'normal', C.muted);
        textAt(pdfSafe(`${d.name}, ${prettyDate(d.date)}`), M, y + sh + 1.5, 8);
        y += sh + 8;
      } else {
        font(10, 'normal', C.muted); textAt('Not signed', M, y, 10); y += 8;
      }
    }

    // ---- Photos
    const photos = state.photos.filter((p) => !p.broken);
    if (photos.length) {
      doc.addPage(); y = M;
      font(13, 'bold'); textAt('Van photos', M, y, 13);
      y += 7;
      doc.setFillColor(...C.hivis); doc.rect(M, y, CW, 1.2, 'F');
      y += 5;

      const gap = 6, colW = (CW - gap) / 2, maxH = 100;
      for (let i = 0; i < photos.length; i += 2) {
        const row = photos.slice(i, i + 2).map((p) => {
          let w = colW, h = colW * (p.h / p.w);
          if (h > maxH) { h = maxH; w = maxH * (p.w / p.h); }
          return { p, w, h };
        });
        const rowH = Math.max(...row.map((r) => r.h));
        ensure(rowH + 9);
        for (let j = 0; j < row.length; j++) {
          const { p, w, h } = row[j];
          const n = i + j + 1;
          const x = M + j * (colW + gap) + (colW - w) / 2;
          try {
            const data = await blobToDataURL(p.blob);
            doc.addImage(data, 'JPEG', x, y, w, h, 'photo' + n, 'NONE');
            doc.setDrawColor(...C.line); doc.setLineWidth(0.2); doc.rect(x, y, w, h);
          } catch (e) {
            warnings.push(`Photo ${n} couldn’t be added to the PDF. Go back, remove it and add it again.`);
            doc.setDrawColor(...C.fail); doc.rect(x, y, w, h);
            font(9, 'normal', C.fail); textAt(`Photo ${n} could not be added`, x + 3, y + 3, 9);
          }
          font(8, 'normal', C.muted);
          textAt(`Photo ${n} of ${photos.length}`, x, y + h + 1.5, 8);
        }
        y += rowH + 9;
      }
    }

    // ---- Footer on every page
    const pages = doc.getNumberOfPages();
    const reg = state.answers['vehicle-reg'] ? ` - ${state.answers['vehicle-reg']}` : '';
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setDrawColor(...C.line); doc.setLineWidth(0.2);
      doc.line(M, PH - M - 4, PW - M, PH - M - 4);
      font(8, 'normal', C.muted);
      doc.text(pdfSafe(`${T.title}${reg} - ${d.name} - ${prettyDate(d.date)}`).slice(0, 110), M, PH - M);
      doc.text(`Page ${i} of ${pages}`, PW - M, PH - M, { align: 'right' });
    }

    doc.setProperties({
      title: pdfSafe(`${T.title} - ${d.name} - ${d.date}`),
      subject: 'Monthly vehicle check',
      author: pdfSafe(d.name),
      creator: 'Van check page',
    });

    const safeName = d.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'driver';
    const safeReg = String(state.answers['vehicle-reg'] || '').replace(/[^A-Za-z0-9]/g, '');
    return {
      blob: doc.output('blob'),
      name: `vehicle-check${safeReg ? '_' + safeReg : ''}_${safeName}_${d.date}.pdf`,
      pages,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------
  function showForm() {
    byId('resultScreen').hidden = true;
    byId('formScreen').hidden = false;
    byId('formBar').hidden = false;
    state.pdf = null;
    state.pdfFile = null;
    window.scrollTo(0, 0);
    sig.size();
  }

  function showResults() {
    const d = detailValues();
    const flaggedCount = QUESTIONS.filter(isFlagged).length;
    byId('formScreen').hidden = true;
    byId('formBar').hidden = true;
    byId('resultScreen').hidden = false;

    byId('resultSummary').textContent =
      `${d.name}${state.answers['vehicle-reg'] ? ', ' + state.answers['vehicle-reg'] : ''}, ${prettyDate(d.date)}. ` +
      `${state.photos.length} photo${state.photos.length === 1 ? '' : 's'}, ${state.pdf.pages} pages, ${kb(state.pdf.blob.size)}. ` +
      (flaggedCount ? `${flaggedCount} item${flaggedCount === 1 ? '' : 's'} marked as needing attention.` : 'No defects reported.');

    const w = byId('pdfWarnings');
    w.hidden = !state.pdf.warnings.length;
    w.textContent = state.pdf.warnings.join(' ');

    state.pdfFile = new File([state.pdf.blob], state.pdf.name, { type: 'application/pdf' });


    setSendStatus('');
    window.scrollTo(0, 0);
    byId('h-ready').focus({ preventScroll: true });
  }

  async function onCreate() {
    const btn = byId('createBtn');
    const problems = validate();
    if (problems.length) {
      const first = problems[0][0];
      const target = containerFor(first);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const focusable = target.querySelector('input, textarea, button, canvas');
        if (focusable && focusable.tagName !== 'CANVAS') setTimeout(() => focusable.focus({ preventScroll: true }), 350);
      }
      toast(problems.length === 1
        ? 'One answer still needs filling in. It’s highlighted in red.'
        : `${problems.length} answers still need filling in. The first one is highlighted in red.`);
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating PDF…';
    saveDraft();
    try {
      state.pdf = await buildPdf();
      showResults();
    } catch (e) {
      console.error(e);
      toast('The PDF couldn’t be created. Your answers are saved. Try again, and if it keeps happening remove any photo that looks wrong.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create PDF';
    }
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------
  function downloadPdf() {
    const url = URL.createObjectURL(state.pdf.blob);
    const a = el('a', { href: url, download: state.pdf.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function onDownload() {
    if (!state.pdf) return;
    downloadPdf();
    toast('PDF downloaded. On iPhone, tap the share icon and choose “Save to Files” to keep it.', 'info');
  }

  // -------------------------------------------------------------------------
  // Share: opens the phone's (or computer's) share menu with the PDF attached,
  // so the operative chooses how to send it: Outlook, Mail, Gmail, WhatsApp,
  // Teams and so on. Where a browser can't share files, the PDF downloads.
  // -------------------------------------------------------------------------
  const canShareFile = () => !!(state.pdfFile && navigator.canShare && navigator.canShare({ files: [state.pdfFile] }));

  function shareText() {
    const d = detailValues();
    const reg = state.answers['vehicle-reg'] ? ` (${state.answers['vehicle-reg']})` : '';
    return {
      title: `Monthly vehicle check: ${d.name}${reg}, ${prettyDate(d.date)}`,
      text: `Please find attached my monthly vehicle check${reg} for ${prettyDate(d.date)}.\n\n${d.name}`,
    };
  }

  function setSendStatus(msg, kind) {
    const s = byId('sendStatus');
    s.textContent = msg || '';
    s.className = 'status' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
  }

  // Runs straight from the tap with nothing awaited first: phones only allow
  // the share menu to open as the immediate result of a tap.
  function onShare() {
    if (!state.pdf) return;
    if (!canShareFile()) {
      downloadPdf();
      setSendStatus('This browser can’t open a share menu, so the PDF has been downloaded instead. Send it from your Downloads or Files.', 'error');
      return;
    }
    const { title, text } = shareText();
    navigator.share({ files: [state.pdfFile], title, text })
      .then(() => {
        setSendStatus('Shared. Make sure it has actually been sent, then tap “Finish and clear this check from my phone”.', 'ok');
      })
      .catch((e) => {
        if (e && e.name === 'AbortError') {
          setSendStatus('Nothing was shared. Your answers and PDF are still here. Tap “Share PDF” to try again.', 'error');
        } else {
          downloadPdf();
          setSendStatus('The share menu didn’t open, so the PDF has been downloaded instead. Send it from your Downloads or Files.', 'error');
        }
      });
  }

  // -------------------------------------------------------------------------
  // Finish / start again
  // -------------------------------------------------------------------------
  async function onFinish() {
    const ok = window.confirm('This clears your answers, photos and signature from this phone. Make sure you’ve shared or downloaded the PDF first.');
    if (!ok) return;
    await clearDraft();
    location.reload();
  }

  async function onDiscardDraft() {
    const ok = window.confirm('Delete your unfinished check and start a blank one?');
    if (!ok) return;
    await clearDraft();
    location.reload();
  }

  // -------------------------------------------------------------------------
  // Start up
  // -------------------------------------------------------------------------
  async function init() {
    document.title = 'Monthly vehicle checklist';
    byId('lbl-opName').textContent = LABELS.driver;
    byId('lbl-checkDate').textContent = LABELS.date;
    byId('photoHint').textContent = T.photoHint || '';
    if (!SIG) byId('field-signature').hidden = true;
    else byId('h-signature').textContent = SIG.text;

    const dateInput = byId('checkDate');
    dateInput.value = todayISO();
    dateInput.max = todayISO();

    renderHeaderFields();
    renderQuestions();
    renderPhotos();

    ['opName', 'checkDate'].forEach((id) => {
      byId(id).addEventListener('input', () => { clearError(id); updateProgress(); scheduleSave(); });
    });
    byId('camInput').addEventListener('change', (e) => addFiles(e.target));
    byId('libInput').addEventListener('change', (e) => addFiles(e.target));
    byId('createBtn').addEventListener('click', onCreate);
    byId('downloadBtn').addEventListener('click', onDownload);
    byId('shareBtn').addEventListener('click', onShare);
    byId('editBtn').addEventListener('click', showForm);
    byId('finishBtn').addEventListener('click', onFinish);
    byId('discardDraftBtn').addEventListener('click', onDiscardDraft);

    // Save when the phone switches app or locks, so nothing is lost.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraft(); });
    window.addEventListener('pagehide', saveDraft);

    await restoreDraft();
    sig.size();
    updateProgress();

    // Let the page open with no signal next time (GitHub Pages serves HTTPS).
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
