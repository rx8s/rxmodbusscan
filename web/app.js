import { AREAS, FAST_MIN_BLOCK, MAX_CONSECUTIVE_FAILURES, referenceLabel, scan } from './scan.js';
import { createLivePoller } from './live.js';
import { RtuClient } from './rtu.js';

const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const state = {
  transport: 'tcp', serial: null, snapshot: new Map(), selected: new Set(), failures: [],
  summary: null, scanning: false, controller: null, poller: null, liveValues: new Map(),
  liveCells: new Map(), context: null, scanId: null, selectionWrites: Promise.resolve(), liveWrites: Promise.resolve(), liveBuffer: [], liveBufferScanId: null, liveFlushTimer: null, saveErrorShown: false, page: 1, renderTimer: null
};
const keyOf = row => `${row.functionCode}:${row.address}`;
const areaName = code => AREAS.find(area => area.functionCode === code)?.name || `FC${code}`;
const fmt = value => Number(value).toLocaleString('en-US');
const clock = time => time ? new Date(time).toLocaleTimeString('th-TH', { hour12: false }) : '—';

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 5000);
}

function status(message, error = false) {
  $('connection-pill').lastChild.textContent = message;
  $('connection-pill').classList.toggle('error', error);
}

function setTransport(transport) {
  if (state.scanning || state.poller?.running) return toast('หยุดการทำงานก่อนเปลี่ยนการเชื่อมต่อ');
  state.transport = transport;
  $('transport-tcp').classList.toggle('active', transport === 'tcp');
  $('transport-rtu').classList.toggle('active', transport === 'rtu');
  $('transport-tcp').setAttribute('aria-pressed', String(transport === 'tcp'));
  $('transport-rtu').setAttribute('aria-pressed', String(transport === 'rtu'));
  $('tcp-fields').classList.toggle('hidden', transport !== 'tcp');
  $('rtu-fields').classList.toggle('hidden', transport !== 'rtu');
  status(transport === 'tcp' ? 'พร้อมสแกน TCP' : state.serial ? 'เชื่อมต่อ Serial' : 'รอเลือกพอร์ต Serial');
  saveSettings();
}

function clearFormErrors() {
  for (const id of ['connection-error', 'range-error']) {
    $(id).textContent = '';
    $(id).classList.add('hidden');
  }
  all('[aria-invalid="true"]').forEach(node => node.removeAttribute('aria-invalid'));
}

function showScanError(message) {
  clearFormErrors();
  const range = /ช่วง address|ประเภทข้อมูล|chunk/i.test(message);
  const target = $(range ? 'range-error' : 'connection-error');
  target.textContent = message;
  target.classList.remove('hidden');
  target.tabIndex = -1;
  target.focus();
  const fields = range ? ['start', 'end'] : /Port|Host|IP/i.test(message) ? ['host', 'port'] : /Unit ID/i.test(message) ? [state.transport === 'tcp' ? 'tcp-unit' : 'rtu-unit'] : /Timeout/i.test(message) ? ['timeout'] : [];
  fields.forEach(id => $(id).setAttribute('aria-invalid', 'true'));
}

function getSettings() {
  const rangeMode = document.querySelector('input[name="range-mode"]:checked')?.value || 'range';
  const start = rangeMode === 'all' ? 0 : Number($('start').value);
  const end = rangeMode === 'all' ? 65535 : Number($('end').value);
  const areas = all('input[name="area"]:checked').map(node => Number(node.value));
  const timeoutMs = Number($('timeout').value);
  const unitId = Number($(state.transport === 'tcp' ? 'tcp-unit' : 'rtu-unit').value);
  if (!areas.length) throw new Error('เลือกประเภทข้อมูลอย่างน้อยหนึ่งประเภท');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 65535 || start > end) throw new Error('ช่วง address ต้องอยู่ระหว่าง 0–65535 และเริ่มต้นไม่เกินสิ้นสุด');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Timeout ต้องอยู่ระหว่าง 100–30000 ms');
  if (!Number.isInteger(unitId) || unitId < (state.transport === 'tcp' ? 0 : 1) || unitId > 247) throw new Error('Unit ID ไม่ถูกต้อง');
  const common = { transport: state.transport, start, end, areas, timeoutMs, unitId, minBlock: $('fast-scan').checked ? FAST_MIN_BLOCK : 1 };
  if (state.transport === 'tcp') {
    const host = $('host').value.trim();
    const port = Number($('port').value);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('กรอก IP/Host และ Port ให้ถูกต้อง');
    return { ...common, host, port };
  }
  return { ...common, baudRate: Number($('baud').value), dataBits: Number($('data-bits').value), stopBits: Number($('stop-bits').value), parity: $('parity').value };
}

function updateEstimate() {
  const allMode = document.querySelector('input[name="range-mode"]:checked')?.value === 'all';
  $('range-fields').classList.toggle('hidden', allMode);
  const areas = all('input[name="area"]:checked').map(node => Number(node.value));
  const start = allMode ? 0 : Number($('start').value);
  const end = allMode ? 65535 : Number($('end').value);
  const addresses = Number.isInteger(start) && Number.isInteger(end) && end >= start ? end - start + 1 : 0;
  const minBlock = $('fast-scan').checked ? FAST_MIN_BLOCK : 1;
  let minimum = 0;
  let maximum = 0;
  for (const area of areas) {
    const size = Math.min(addresses, area <= 2 ? 256 : 64);
    const chunks = size ? Math.ceil(addresses / size) : 0;
    minimum += chunks;
    // Worst case: every block answers "illegal address" and is halved down to minBlock.
    maximum += chunks * Math.max(1, 2 * Math.ceil(size / minBlock) - 1);
  }
  $('scan-estimate').textContent = `${fmt(addresses * areas.length)} จุด · ประมาณ ${fmt(minimum)}–${fmt(maximum)} คำขอ${allMode ? ' · การสแกนทั้งหมดอาจใช้เวลานานมาก' : ''}`;
}

function saveSettings() {
  const ids = ['host', 'port', 'tcp-unit', 'rtu-unit', 'baud', 'data-bits', 'stop-bits', 'parity', 'timeout', 'start', 'end', 'live-interval'];
  const values = Object.fromEntries(ids.map(id => [id, $(id).value]));
  values.transport = state.transport;
  values.rangeMode = document.querySelector('input[name="range-mode"]:checked')?.value;
  values.areas = all('input[name="area"]:checked').map(node => node.value);
  values.fastScan = $('fast-scan').checked;
  localStorage.setItem('modbus-settings-v1', JSON.stringify(values));
}

function restoreSettings() {
  try {
    const values = JSON.parse(localStorage.getItem('modbus-settings-v1') || 'null');
    if (!values) return;
    for (const [id, value] of Object.entries(values)) if ($(id) && typeof value === 'string') $(id).value = value;
    if (values.rangeMode) document.querySelector(`input[name="range-mode"][value="${values.rangeMode}"]`)?.click();
    $('fast-scan').checked = values.fastScan === true;
    if (Array.isArray(values.areas)) all('input[name="area"]').forEach(node => { node.checked = values.areas.includes(node.value); });
    if (values.transport === 'rtu') setTransport('rtu');
  } catch { /* damaged local preferences are ignored */ }
}

function openLegacyDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('modbus-scan-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveSnapshot() {
  try {
    const response = await fetch('/api/scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows: [...state.snapshot.values()], failures: state.failures, summary: state.summary, selected: [...state.selected], context: state.context?.transport === 'tcp' ? state.context : { transport: 'rtu' } }) });
    if (!response.ok) throw new Error((await response.json()).error || 'บันทึก SQLite ไม่สำเร็จ');
    state.scanId = (await response.json()).id;
    state.saveErrorShown = false;
  } catch (error) { toast(`บันทึกไฟล์ .db ไม่สำเร็จ: ${error.message}`); }
}

function saveSelection() {
  if (!state.scanId) return;
  const scanId = state.scanId;
  const selected = [...state.selected];
  state.selectionWrites = state.selectionWrites.then(async () => {
    const response = await fetch(`/api/scans/${scanId}/selection`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected }) });
    if (!response.ok) throw new Error('บันทึกรายการ LIVE ไม่สำเร็จ');
  }).catch(error => toast(error.message));
  return state.selectionWrites;
}

const LIVE_BATCH_SIZE = 200;
const LIVE_FLUSH_MS = 1000;

// Live samples are buffered and written in batches so SQLite commits once per batch, not per value.
function saveLiveSample(row) {
  if (!state.scanId) return;
  if (state.liveBufferScanId !== state.scanId) flushLiveSamples();
  state.liveBufferScanId = state.scanId;
  const sample = { functionCode: row.functionCode, address: row.address, status: row.status, time: row.time };
  if (row.status === 'ok') sample.value = row.value;
  if (row.message) sample.message = String(row.message).slice(0, 1000);
  state.liveBuffer.push(sample);
  if (state.liveBuffer.length >= LIVE_BATCH_SIZE) flushLiveSamples();
  else state.liveFlushTimer ??= setTimeout(flushLiveSamples, LIVE_FLUSH_MS);
}

function flushLiveSamples(unloading = false) {
  clearTimeout(state.liveFlushTimer);
  state.liveFlushTimer = null;
  if (!state.liveBuffer.length) return state.liveWrites;
  const scanId = state.liveBufferScanId;
  const samples = state.liveBuffer;
  state.liveBuffer = [];
  const send = async () => {
    // keepalive lets the last batch survive page unload, but caps the body at 64 KB, so use it only then.
    const response = await fetch(`/api/scans/${scanId}/live`, { method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: unloading, body: JSON.stringify({ samples }) });
    if (!response.ok) throw new Error('บันทึกประวัติค่าสดไม่สำเร็จ');
  };
  state.liveWrites = (unloading ? send() : state.liveWrites.then(send)).catch(error => { if (!state.saveErrorShown) toast(error.message); state.saveErrorShown = true; });
  return state.liveWrites;
}

async function loadLegacySnapshot() {
  try {
    const db = await openLegacyDatabase();
    const saved = await new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readonly');
      const request = tx.objectStore('snapshots').get('latest');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return saved;
  } catch { return null; }
}

async function restoreSnapshot() {
  try {
    const response = await fetch('/api/scans/latest');
    if (!response.ok) throw new Error('โหลด SQLite ไม่สำเร็จ');
    let saved = await response.json();
    const legacy = !saved;
    if (legacy) saved = await loadLegacySnapshot();
    if (!saved) return;
    state.scanId = saved.id || null;
    state.snapshot = new Map(saved.rows.map(row => [keyOf(row), row]));
    state.failures = saved.failures || [];
    state.summary = saved.summary;
    state.selected = new Set(saved.selected || []);
    state.context = saved.context;
    renderAll();
    if (legacy) await saveSnapshot();
  } catch (error) { toast(error.message); }
}

async function closeSerial(message = 'ยังไม่ได้เลือกพอร์ต') {
  const client = state.serial;
  state.serial = null;
  if (client) { try { await client.close(); } catch (error) { toast(error.message); } }
  $('choose-port').textContent = 'เลือกพอร์ต USB / Serial';
  $('serial-status').textContent = message;
}

async function chooseSerialPort() {
  if (state.serial) {
    if (state.scanning) state.controller?.abort();
    if (state.poller?.running) await stopLive();
    await closeSerial();
    status('ตัดการเชื่อมต่อ Serial');
    return;
  }
  if (!('serial' in navigator)) return toast('เบราว์เซอร์นี้ไม่รองรับ Web Serial · ใช้ Chrome บน localhost');
  try {
    const port = await navigator.serial.requestPort();
    const client = new RtuClient(port);
    await client.open({ baudRate: Number($('baud').value), dataBits: Number($('data-bits').value), stopBits: Number($('stop-bits').value), parity: $('parity').value });
    state.serial = client;
    $('choose-port').textContent = 'ตัดการเชื่อมต่อ';
    $('serial-status').textContent = 'เชื่อมต่อพอร์ตแล้ว';
    status('เชื่อมต่อ Serial');
  } catch (error) { toast(error.message || 'เลือกพอร์ตไม่สำเร็จ'); }
}

async function readTcpRequest(settings, request) {
  const { signal, ...readOptions } = request;
  const response = await fetch('/api/read', { method: 'POST', headers: { 'content-type': 'application/json' }, signal, body: JSON.stringify({ host: settings.host, port: settings.port, unitId: settings.unitId, timeoutMs: settings.timeoutMs, ...readOptions }) });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || 'อ่าน TCP ไม่สำเร็จ');
    error.kind = body.kind;
    error.exceptionCode = body.exceptionCode;
    throw error;
  }
  return body.values;
}

function makeRead(settings) {
  if (settings.transport === 'rtu') {
    if (!state.serial || (settings.serialPort && state.serial.port !== settings.serialPort)) throw new Error('เชื่อมต่อ Serial และสแกนใหม่ก่อนอ่านค่าสด');
    return request => state.serial.read({ unitId: settings.unitId, timeoutMs: settings.timeoutMs, ...request });
  }
  return request => readTcpRequest(settings, request);
}

function renderStats() {
  const summary = state.summary || {};
  for (const field of ['readable', 'invalid', 'unsupported', 'failed']) $(`stat-${field}`).textContent = fmt(summary[field] || 0);
  $('snapshot-tab-count').textContent = fmt(state.snapshot.size);
  $('failure-count').textContent = fmt(summary.invalid + summary.unsupported + summary.failed || 0);
  $('export-csv').disabled = state.snapshot.size === 0;
}

function scheduleRender() {
  if (state.renderTimer) return;
  state.renderTimer = setTimeout(() => { state.renderTimer = null; renderSnapshot(); }, 250);
}

function renderSnapshot() {
  const query = $('search').value.trim().toLowerCase();
  const filter = $('area-filter').value;
  const matched = [...state.snapshot.values()].filter(row =>
    (filter === 'all' || row.functionCode === Number(filter)) &&
    (!query || String(row.address).includes(query) || referenceLabel(row.functionCode, row.address).includes(query) || String(row.value).includes(query) || areaName(row.functionCode).toLowerCase().includes(query))
  );
  const pages = Math.ceil(matched.length / 100);
  state.page = Math.max(1, Math.min(state.page, pages || 1));
  const visible = matched.slice((state.page - 1) * 100, state.page * 100);
  const body = $('snapshot-body');
  body.replaceChildren();
  if (!visible.length) {
    const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = 7; cell.className = 'empty-cell'; cell.textContent = state.scanning ? 'กำลังค้นหาค่าที่อ่านได้...' : 'ไม่พบข้อมูล';
  }
  for (const item of visible) {
    const row = body.insertRow();
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(keyOf(item)); checkbox.setAttribute('aria-label', `ติดตาม ${areaName(item.functionCode)} address ${item.address}`);
    checkbox.addEventListener('change', async () => { if (state.poller?.running) await stopLive(); if (checkbox.checked) state.selected.add(keyOf(item)); else state.selected.delete(keyOf(item)); renderLive(); saveSelection(); });
    const checkboxLabel = document.createElement('label'); checkboxLabel.className = 'table-checkbox'; checkboxLabel.append(checkbox);
    row.insertCell().append(checkboxLabel);
    const badge = document.createElement('span'); badge.className = 'area-badge'; badge.textContent = areaName(item.functionCode); row.insertCell().append(badge);
    const address = row.insertCell(); address.className = 'mono'; address.textContent = item.address;
    const reference = row.insertCell(); reference.className = 'mono muted'; reference.textContent = referenceLabel(item.functionCode, item.address);
    const value = row.insertCell(); value.className = 'value'; value.textContent = item.functionCode <= 2 ? (item.value ? 'ON' : 'OFF') : fmt(item.value);
    const hex = row.insertCell(); hex.className = 'mono muted'; hex.textContent = item.functionCode <= 2 ? '—' : `0x${item.value.toString(16).toUpperCase().padStart(4, '0')}`;
    const time = row.insertCell(); time.className = 'muted'; time.textContent = clock(item.time);
  }
  $('result-count').textContent = `${fmt(matched.length)} รายการ`;
  $('page-label').textContent = `หน้า ${pages ? state.page : 0} / ${pages}`;
  $('prev-page').disabled = state.page <= 1;
  $('next-page').disabled = state.page >= pages;
  const failures = $('failure-list'); failures.replaceChildren();
  for (const item of state.failures.slice(-100)) {
    const line = document.createElement('div'); line.textContent = `${areaName(item.functionCode)} · ${item.address}${item.count > 1 ? `–${item.address + item.count - 1}` : ''} · ${item.message || item.status}`; failures.append(line);
  }
}

function applyLiveCell(item) {
  const cells = state.liveCells.get(keyOf(item));
  if (!cells) return;
  const live = state.liveValues.get(keyOf(item));
  cells.value.textContent = live?.value === undefined ? '—' : item.functionCode <= 2 ? (live.value ? 'ON' : 'OFF') : fmt(live.value);
  cells.hex.textContent = live?.value !== undefined && item.functionCode > 2 ? `0x${live.value.toString(16).toUpperCase().padStart(4, '0')}` : '—';
  cells.status.className = live?.status === 'failed' ? 'status-failed' : 'status-ok';
  cells.status.textContent = live?.status === 'failed' ? `ข้อมูลเก่า · ${live.message}` : live && state.poller?.running ? 'ปกติ' : live ? 'ข้อมูลเก่า · หยุดอ่าน' : 'รออ่าน';
  cells.time.textContent = clock(live?.time);
}

function renderLive() {
  const selected = [...state.selected].map(key => state.snapshot.get(key)).filter(Boolean);
  $('live-tab-count').textContent = fmt(selected.length);
  $('live-note').textContent = state.poller?.running ? `กำลังอ่านซ้ำ ${fmt(selected.length)} address` : selected.length ? `เลือกแล้ว ${fmt(selected.length)} address · กดเริ่มอ่านค่าสด` : 'ยังไม่ได้เลือก address · เลือกช่อง LIVE ในหมวดผลสแกนครั้งเดียว';
  const body = $('live-body'); body.replaceChildren(); state.liveCells.clear();
  if (!selected.length) { const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = 8; cell.className = 'empty-cell'; cell.textContent = 'ยังไม่มี address ที่เลือก'; }
  for (const item of selected.slice(0, 500)) {
    const row = body.insertRow();
    row.insertCell().textContent = areaName(item.functionCode);
    row.insertCell().textContent = item.address;
    row.insertCell().textContent = referenceLabel(item.functionCode, item.address);
    const value = row.insertCell(); value.className = 'value';
    const hex = row.insertCell(); hex.className = 'mono muted';
    const statusCell = row.insertCell();
    const time = row.insertCell(); time.className = 'muted';
    state.liveCells.set(keyOf(item), { value, hex, status: statusCell, time });
    applyLiveCell(item);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'page-button'; remove.textContent = 'นำออก'; remove.setAttribute('aria-label', `นำ ${areaName(item.functionCode)} address ${item.address} ออกจากค่าสด`); remove.onclick = async () => { if (state.poller?.running) await stopLive(); state.selected.delete(keyOf(item)); renderSnapshot(); renderLive(); saveSelection(); }; row.insertCell().append(remove);
  }
  if (selected.length > 500) $('live-note').textContent += ' · ตารางแสดง 500 รายการแรก';
}

function renderAll() { renderStats(); renderSnapshot(); renderLive(); }

function updateProgress(summary) {
  state.summary = summary;
  renderStats();
  $('progress-count').textContent = `${fmt(summary.processed)} / ${fmt(summary.total)}`;
  $('progress-bar').style.width = `${Math.min(100, summary.processed / summary.total * 100)}%`;
  $('progress-bar').parentElement.setAttribute('aria-valuenow', String(Math.round(summary.processed / summary.total * 100)));
  $('progress-detail').textContent = `${fmt(summary.requests)} คำขอ · อ่านได้ ${fmt(summary.readable)} · ใช้ไม่ได้ ${fmt(summary.invalid)} · ผิดพลาด ${fmt(summary.failed)}`;
}

async function startScan() {
  if (state.scanning || state.poller?.running) return toast('หยุดค่าสดก่อนเริ่มสแกนใหม่');
  let settings;
  try { settings = getSettings(); makeRead(settings); } catch (error) { return showScanError(error.message); }
  clearFormErrors();
  state.context = { ...settings, serialPort: settings.transport === 'rtu' ? state.serial?.port : undefined };
  const read = makeRead(settings);
  state.snapshot.clear(); state.selected.clear(); state.failures = []; state.liveValues.clear(); state.scanId = null; state.page = 1;
  state.summary = { total: (settings.end - settings.start + 1) * settings.areas.length, processed: 0, readable: 0, invalid: 0, unsupported: 0, failed: 0, requests: 0 };
  state.scanning = true; state.controller = new AbortController();
  $('start-scan').classList.add('hidden'); $('stop-scan').classList.remove('hidden'); $('progress-box').classList.remove('hidden');
  $('progress-label').textContent = 'กำลังสแกน';
  status('กำลังสแกน'); renderAll(); saveSettings();
  let disconnectSerial = false;
  try {
    const summary = await scan({ read, areas: settings.areas, start: settings.start, end: settings.end, minBlock: settings.minBlock, signal: state.controller.signal,
      onProgress: updateProgress,
      onResult: result => { if (result.status === 'ok') state.snapshot.set(keyOf(result), result); else if (state.failures.length < 500) state.failures.push(result); scheduleRender(); }
    });
    updateProgress(summary);
    disconnectSerial = settings.transport === 'rtu' && (summary.cancelled || summary.stopped);
    $('progress-label').textContent = summary.cancelled ? 'หยุดสแกนแล้ว' : summary.stopped ? 'หยุดเพราะการเชื่อมต่อผิดพลาด' : 'สแกนเสร็จ';
    status(summary.cancelled ? 'หยุดสแกนแล้ว' : summary.stopped ? 'การเชื่อมต่อผิดพลาด' : 'สแกนเสร็จ', summary.stopped);
    if (summary.stopped && !summary.cancelled) toast(`หยุดสแกนเพราะสื่อสารกับอุปกรณ์ไม่สำเร็จ (ผิดพลาดติดกันสูงสุด ${MAX_CONSECUTIVE_FAILURES} ครั้ง) · ตรวจสอบ IP/Port หรือการตั้งค่า Serial`);
    await saveSnapshot();
  } catch (error) { disconnectSerial = settings.transport === 'rtu'; status('สแกนผิดพลาด', true); toast(error.message); }
  finally {
    if (disconnectSerial && state.serial) await closeSerial('ต้องเลือกพอร์ตใหม่');
    state.scanning = false; state.controller = null; $('start-scan').classList.remove('hidden'); $('stop-scan').classList.add('hidden'); renderAll();
  }
}

function startLive() {
  if (state.scanning || state.poller?.running) return;
  const items = [...state.selected].map(key => state.snapshot.get(key)).filter(Boolean);
  if (!items.length) return toast('เลือก address จากผลสแกนก่อน');
  if (items.length > 500) return toast('ค่าสดรองรับครั้งละไม่เกิน 500 address');
  if (!state.context) return toast('สแกนใหม่ก่อนเริ่มค่าสด');
  if (state.context.transport === 'rtu' && !state.context.serialPort) return toast('ผล Serial ที่บันทึกไว้ต้องสแกนใหม่ก่อนอ่านค่าสด');
  let read;
  try { read = makeRead(state.context); } catch (error) { return toast(error.message); }
  const interval = Number($('live-interval').value);
  state.poller = createLivePoller({ read,
    onUpdate: row => { state.liveValues.set(keyOf(row), row); applyLiveCell(row); saveLiveSample(row); },
    onError: row => { const last = state.liveValues.get(keyOf(row)); state.liveValues.set(keyOf(row), { ...row, value: last?.value, time: last?.time }); applyLiveCell(row); saveLiveSample(row); },
    onStopped: error => {
      $('start-live').classList.remove('hidden'); $('stop-live').classList.add('hidden');
      status('การเชื่อมต่อค่าสดผิดพลาด', true); toast(error.message); renderLive();
      if (state.context?.transport === 'rtu') closeSerial('ต้องเลือกพอร์ตใหม่');
    }
  });
  try { state.poller.start(items, interval); } catch (error) { return toast(error.message); }
  $('start-live').classList.add('hidden'); $('stop-live').classList.remove('hidden');
  status('กำลังอ่านค่าสด'); renderLive(); saveSettings();
}

async function stopLive() {
  $('stop-live').disabled = true;
  try { await state.poller?.stop(); await flushLiveSamples(); } finally { $('stop-live').disabled = false; }
  if (state.context?.transport === 'rtu' && state.serial?.desynced) await closeSerial('ต้องเลือกพอร์ตใหม่');
  $('start-live').classList.remove('hidden'); $('stop-live').classList.add('hidden');
  status('หยุดค่าสดแล้ว'); renderLive();
}

function exportCsv() {
  const lines = ['function_code,area,address,reference,raw_value,hex,last_read'];
  for (const row of state.snapshot.values()) lines.push([row.functionCode, areaName(row.functionCode), row.address, referenceLabel(row.functionCode, row.address), row.value, row.functionCode <= 2 ? '' : `0x${row.value.toString(16).toUpperCase().padStart(4, '0')}`, new Date(row.time).toISOString()].join(','));
  const blob = new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `modbus-scan-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function selectTab(tab) {
  $('snapshot-panel').classList.toggle('hidden', tab !== 'snapshot');
  $('live-panel').classList.toggle('hidden', tab !== 'live');
  $('tab-snapshot').classList.toggle('active', tab === 'snapshot');
  $('tab-live').classList.toggle('active', tab === 'live');
  $('tab-snapshot').setAttribute('aria-selected', String(tab === 'snapshot'));
  $('tab-live').setAttribute('aria-selected', String(tab === 'live'));
  $('tab-snapshot').tabIndex = tab === 'snapshot' ? 0 : -1;
  $('tab-live').tabIndex = tab === 'live' ? 0 : -1;
}

$('transport-tcp').onclick = () => setTransport('tcp');
$('transport-rtu').onclick = () => setTransport('rtu');
$('choose-port').onclick = chooseSerialPort;
$('start-scan').onclick = startScan;
$('stop-scan').onclick = () => { state.controller?.abort(); $('progress-label').textContent = 'กำลังหยุด...'; };
$('tab-snapshot').onclick = () => selectTab('snapshot');
$('tab-live').onclick = () => selectTab('live');
for (const tab of ['snapshot', 'live']) $(tab === 'snapshot' ? 'tab-snapshot' : 'tab-live').addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const next = tab === 'snapshot' ? 'live' : 'snapshot';
    selectTab(next);
    $(next === 'snapshot' ? 'tab-snapshot' : 'tab-live').focus();
  }
});
$('start-live').onclick = startLive;
$('stop-live').onclick = stopLive;
$('export-csv').onclick = exportCsv;
$('prev-page').onclick = () => { state.page--; renderSnapshot(); };
$('next-page').onclick = () => { state.page++; renderSnapshot(); };
$('search').oninput = () => { state.page = 1; scheduleRender(); };
$('area-filter').onchange = () => { state.page = 1; renderSnapshot(); };
all('input[name="range-mode"],input[name="area"],#start,#end,#fast-scan').forEach(node => node.addEventListener('change', () => { updateEstimate(); saveSettings(); }));
function refreshFormErrors() {
  if ($('connection-error').classList.contains('hidden') && $('range-error').classList.contains('hidden')) return;
  try { getSettings(); clearFormErrors(); } catch { /* keep the error until all settings are valid */ }
}
all('input,select').forEach(node => {
  node.addEventListener('input', refreshFormErrors);
  node.addEventListener('change', () => { saveSettings(); refreshFormErrors(); });
});
all('#baud,#data-bits,#stop-bits,#parity').forEach(node => node.addEventListener('change', async () => {
  if (state.serial && !state.scanning && !state.poller?.running) { await state.serial.close(); state.serial = null; $('choose-port').textContent = 'เลือกพอร์ต USB / Serial'; $('serial-status').textContent = 'ตั้งค่า Serial เปลี่ยนแล้ว · เลือกพอร์ตอีกครั้ง'; }
}));
window.addEventListener('beforeunload', () => { state.poller?.stop(); state.controller?.abort(); flushLiveSamples(true); });
restoreSettings(); updateEstimate(); renderAll(); restoreSnapshot();
