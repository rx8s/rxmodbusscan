import { AREAS, referenceLabel, scan } from './scan.js';
import { createLivePoller } from './live.js';
import { RtuClient } from './rtu.js';

const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const state = {
  transport: 'tcp', serial: null, snapshot: new Map(), selected: new Set(), failures: [],
  summary: null, scanning: false, controller: null, poller: null, liveValues: new Map(),
  context: null, page: 1, renderTimer: null
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
  $('tcp-fields').classList.toggle('hidden', transport !== 'tcp');
  $('rtu-fields').classList.toggle('hidden', transport !== 'rtu');
  status(transport === 'tcp' ? 'พร้อมสแกน TCP' : state.serial ? 'เชื่อมต่อ Serial' : 'รอเลือกพอร์ต Serial');
  saveSettings();
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
  const common = { transport: state.transport, start, end, areas, timeoutMs, unitId };
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
  const minimum = areas.reduce((sum, area) => sum + Math.ceil(addresses / (area <= 2 ? 256 : 64)), 0);
  $('scan-estimate').textContent = `${fmt(addresses * areas.length)} จุด · อย่างน้อยประมาณ ${fmt(minimum)} คำขอ${allMode ? ' · การสแกนทั้งหมดอาจใช้เวลานานมาก' : ''}`;
}

function saveSettings() {
  const ids = ['host', 'port', 'tcp-unit', 'rtu-unit', 'baud', 'data-bits', 'stop-bits', 'parity', 'timeout', 'start', 'end', 'live-interval'];
  const values = Object.fromEntries(ids.map(id => [id, $(id).value]));
  values.transport = state.transport;
  values.rangeMode = document.querySelector('input[name="range-mode"]:checked')?.value;
  values.areas = all('input[name="area"]:checked').map(node => node.value);
  localStorage.setItem('modbus-settings-v1', JSON.stringify(values));
}

function restoreSettings() {
  try {
    const values = JSON.parse(localStorage.getItem('modbus-settings-v1') || 'null');
    if (!values) return;
    for (const [id, value] of Object.entries(values)) if ($(id) && typeof value === 'string') $(id).value = value;
    if (values.rangeMode) document.querySelector(`input[name="range-mode"][value="${values.rangeMode}"]`)?.click();
    if (Array.isArray(values.areas)) all('input[name="area"]').forEach(node => { node.checked = values.areas.includes(node.value); });
    if (values.transport === 'rtu') setTransport('rtu');
  } catch { /* damaged local preferences are ignored */ }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('modbus-scan-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveSnapshot() {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite');
      tx.objectStore('snapshots').put({ rows: [...state.snapshot.values()], failures: state.failures, summary: state.summary, selected: [...state.selected], context: state.context?.transport === 'tcp' ? state.context : { transport: 'rtu' } }, 'latest');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { toast('บันทึกผลลงเครื่องไม่สำเร็จ แต่ผลยังอยู่บนหน้านี้'); }
}

async function restoreSnapshot() {
  try {
    const db = await openDatabase();
    const saved = await new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readonly');
      const request = tx.objectStore('snapshots').get('latest');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (!saved) return;
    state.snapshot = new Map(saved.rows.map(row => [keyOf(row), row]));
    state.failures = saved.failures || [];
    state.summary = saved.summary;
    state.selected = new Set(saved.selected || []);
    state.context = saved.context;
    renderAll();
  } catch { /* browser storage may be disabled */ }
}

async function chooseSerialPort() {
  if (state.serial) {
    await state.serial.close();
    state.serial = null;
    $('choose-port').textContent = 'เลือกพอร์ต USB / Serial';
    $('serial-status').textContent = 'ยังไม่ได้เลือกพอร์ต';
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
  const response = await fetch('/api/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: settings.host, port: settings.port, unitId: settings.unitId, timeoutMs: settings.timeoutMs, ...request }) });
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
    checkbox.addEventListener('change', () => { if (checkbox.checked) state.selected.add(keyOf(item)); else state.selected.delete(keyOf(item)); renderLive(); saveSnapshot(); });
    row.insertCell().append(checkbox);
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

function renderLive() {
  const selected = [...state.selected].map(key => state.snapshot.get(key)).filter(Boolean);
  $('live-tab-count').textContent = fmt(selected.length);
  $('live-note').textContent = state.poller?.running ? `กำลังอ่านซ้ำ ${fmt(selected.length)} address` : selected.length ? `เลือกแล้ว ${fmt(selected.length)} address · กดเริ่มอ่านค่าสด` : 'ยังไม่ได้เลือก address · เลือกช่อง LIVE ในหมวดผลสแกนครั้งเดียว';
  const body = $('live-body'); body.replaceChildren();
  if (!selected.length) { const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = 8; cell.className = 'empty-cell'; cell.textContent = 'ยังไม่มี address ที่เลือก'; }
  for (const item of selected.slice(0, 500)) {
    const live = state.liveValues.get(keyOf(item));
    const row = body.insertRow();
    row.insertCell().textContent = areaName(item.functionCode);
    row.insertCell().textContent = item.address;
    row.insertCell().textContent = referenceLabel(item.functionCode, item.address);
    const value = row.insertCell(); value.className = 'value'; value.textContent = live?.status === 'ok' ? (item.functionCode <= 2 ? (live.value ? 'ON' : 'OFF') : fmt(live.value)) : '—';
    row.insertCell().textContent = live?.status === 'ok' && item.functionCode > 2 ? `0x${live.value.toString(16).toUpperCase().padStart(4, '0')}` : '—';
    const statusCell = row.insertCell(); statusCell.className = live?.status === 'failed' ? 'status-failed' : 'status-ok'; statusCell.textContent = live?.status === 'failed' ? live.message : live ? 'ปกติ' : 'รออ่าน';
    row.insertCell().textContent = clock(live?.time);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'page-button'; remove.textContent = '×'; remove.title = 'นำออกจากค่าสด'; remove.onclick = () => { if (state.poller?.running) stopLive(); state.selected.delete(keyOf(item)); renderSnapshot(); renderLive(); saveSnapshot(); }; row.insertCell().append(remove);
  }
  if (selected.length > 500) $('live-note').textContent += ' · ตารางแสดง 500 รายการแรก';
}

function renderAll() { renderStats(); renderSnapshot(); renderLive(); }

function updateProgress(summary) {
  state.summary = summary;
  renderStats();
  $('progress-count').textContent = `${fmt(summary.processed)} / ${fmt(summary.total)}`;
  $('progress-bar').style.width = `${Math.min(100, summary.processed / summary.total * 100)}%`;
  $('progress-detail').textContent = `${fmt(summary.requests)} คำขอ · อ่านได้ ${fmt(summary.readable)} · ใช้ไม่ได้ ${fmt(summary.invalid)} · ผิดพลาด ${fmt(summary.failed)}`;
}

async function startScan() {
  if (state.scanning || state.poller?.running) return toast('หยุดค่าสดก่อนเริ่มสแกนใหม่');
  let settings;
  try { settings = getSettings(); makeRead(settings); } catch (error) { return toast(error.message); }
  state.context = { ...settings, serialPort: settings.transport === 'rtu' ? state.serial?.port : undefined };
  const read = makeRead(settings);
  state.snapshot.clear(); state.selected.clear(); state.failures = []; state.liveValues.clear(); state.page = 1;
  state.summary = { total: (settings.end - settings.start + 1) * settings.areas.length, processed: 0, readable: 0, invalid: 0, unsupported: 0, failed: 0, requests: 0 };
  state.scanning = true; state.controller = new AbortController();
  $('start-scan').classList.add('hidden'); $('stop-scan').classList.remove('hidden'); $('progress-box').classList.remove('hidden');
  $('progress-label').textContent = 'กำลังสแกน';
  status('กำลังสแกน'); renderAll(); saveSettings();
  try {
    const summary = await scan({ read, areas: settings.areas, start: settings.start, end: settings.end, signal: state.controller.signal,
      onProgress: updateProgress,
      onResult: result => { if (result.status === 'ok') state.snapshot.set(keyOf(result), result); else if (state.failures.length < 500) state.failures.push(result); scheduleRender(); }
    });
    updateProgress(summary);
    $('progress-label').textContent = summary.cancelled ? 'หยุดสแกนแล้ว' : 'สแกนเสร็จ';
    status(summary.cancelled ? 'หยุดสแกนแล้ว' : 'สแกนเสร็จ');
    await saveSnapshot();
  } catch (error) { status('สแกนผิดพลาด', true); toast(error.message); }
  finally { state.scanning = false; state.controller = null; $('start-scan').classList.remove('hidden'); $('stop-scan').classList.add('hidden'); renderAll(); }
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
    onUpdate: row => { state.liveValues.set(keyOf(row), row); renderLive(); },
    onError: row => { state.liveValues.set(keyOf(row), row); renderLive(); }
  });
  try { state.poller.start(items, interval); } catch (error) { return toast(error.message); }
  $('start-live').classList.add('hidden'); $('stop-live').classList.remove('hidden');
  status('กำลังอ่านค่าสด'); renderLive(); saveSettings();
}

function stopLive() {
  state.poller?.stop();
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
}

$('transport-tcp').onclick = () => setTransport('tcp');
$('transport-rtu').onclick = () => setTransport('rtu');
$('choose-port').onclick = chooseSerialPort;
$('start-scan').onclick = startScan;
$('stop-scan').onclick = () => { state.controller?.abort(); $('progress-label').textContent = 'กำลังหยุด...'; };
$('tab-snapshot').onclick = () => selectTab('snapshot');
$('tab-live').onclick = () => selectTab('live');
$('start-live').onclick = startLive;
$('stop-live').onclick = stopLive;
$('export-csv').onclick = exportCsv;
$('prev-page').onclick = () => { state.page--; renderSnapshot(); };
$('next-page').onclick = () => { state.page++; renderSnapshot(); };
$('search').oninput = () => { state.page = 1; scheduleRender(); };
$('area-filter').onchange = () => { state.page = 1; renderSnapshot(); };
all('input[name="range-mode"],input[name="area"],#start,#end').forEach(node => node.addEventListener('change', () => { updateEstimate(); saveSettings(); }));
all('input,select').forEach(node => node.addEventListener('change', saveSettings));
all('#baud,#data-bits,#stop-bits,#parity').forEach(node => node.addEventListener('change', async () => {
  if (state.serial && !state.scanning && !state.poller?.running) { await state.serial.close(); state.serial = null; $('choose-port').textContent = 'เลือกพอร์ต USB / Serial'; $('serial-status').textContent = 'ตั้งค่า Serial เปลี่ยนแล้ว · เลือกพอร์ตอีกครั้ง'; }
}));
window.addEventListener('beforeunload', () => { state.poller?.stop(); state.controller?.abort(); });
restoreSettings(); updateEstimate(); renderAll(); restoreSnapshot();
