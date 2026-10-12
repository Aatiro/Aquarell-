import './style.css';
import { Engine } from './engine';
import { Mixer } from './mixer';
import { cssColor, latentToRgb, PALETTE, PigmentLatent } from './palette';
import { PaperType, ToolId, Watercolor } from './sim';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ------------------------------------------------------------------ settings
interface Settings {
  tool: ToolId;
  size: number;
  water: number;
  pigment: number;
  colorIndex: number;
  paper: PaperType;
  dry: number;
  edge: number;
  gran: number;
}

const defaults: Settings = { tool: 0, size: 18, water: 60, pigment: 55, colorIndex: 7, paper: 0, dry: 40, edge: 55, gran: 60 };
const settings: Settings = { ...defaults };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('aquarell.settings') || '{}'));
} catch { /* ignore */ }
const save = () => {
  try { localStorage.setItem('aquarell.settings', JSON.stringify(settings)); } catch { /* ignore */ }
};

let color: PigmentLatent = PALETTE[settings.colorIndex] ?? PALETTE[7];
if (settings.colorIndex < 0) color = PALETTE[7];

/** slider 0..100 -> drying speed factor 0.25..4 (exponential) */
const drySpeed = (v: number) => 0.25 * Math.pow(16, v / 100);

// ------------------------------------------------------------------ canvas + simulation
const canvas = $<HTMLCanvasElement>('#paper');
const stage = $('#stage');
const paperBox = $('#sheet-of-paper');

const isCoarse = matchMedia('(pointer: coarse)').matches;
const rect = stage.getBoundingClientRect();
const pad = parseFloat(getComputedStyle(stage).paddingLeft) || 0;
const cssW = Math.max(200, Math.floor(rect.width - pad * 2));
const cssH = Math.max(200, Math.floor(rect.height - pad * 2));
const maxSimPx = isCoarse ? 420_000 : 900_000;
const simScale = Math.min(1, Math.sqrt(maxSimPx / (cssW * cssH)));
const dpr = Math.min(window.devicePixelRatio || 1, 2);

function layoutCanvas() {
  const r = stage.getBoundingClientRect();
  const p = parseFloat(getComputedStyle(stage).paddingLeft) || 0;
  const k = Math.min((r.width - 2 * p) / cssW, (r.height - 2 * p) / cssH, 1.5);
  paperBox.style.width = `${cssW * k}px`;
  paperBox.style.height = `${cssH * k}px`;
  canvas.style.width = `${cssW * k}px`;
  canvas.style.height = `${cssH * k}px`;
}

canvas.width = Math.round(cssW * dpr);
canvas.height = Math.round(cssH * dpr);
layoutCanvas();

let sim: Watercolor;
try {
  sim = new Watercolor(canvas, cssW, cssH, simScale);
} catch (err) {
  const box = $('#error');
  box.hidden = false;
  box.textContent = (err as Error).message;
  throw err;
}
sim.params.drySpeed = drySpeed(settings.dry);
sim.params.edge = (settings.edge / 100) * 0.8;
sim.params.granulation = (settings.gran / 100) * 1.4;
sim.setPaper(settings.paper);

// undo depth from a rough GPU memory budget
const memGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? (isCoarse ? 3 : 8);
const budget = (isCoarse ? 120 : 360) * 1024 * 1024 * Math.min(1, memGB / 4);
const maxUndo = Math.max(4, Math.min(30, Math.floor(budget / sim.snapshotBytes)));
const engine = new Engine(sim, maxUndo);
engine.userDrySpeed = sim.params.drySpeed;

// ------------------------------------------------------------------ painting input
let activePointer: number | null = null;
let penSeen = false;
const cursor = $('#cursor');

function toSim(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * sim.w, (1 - (e.clientY - r.top) / r.height) * sim.h];
}

function pressureOf(e: PointerEvent): number {
  if (e.pointerType === 'pen') return Math.max(0.05, e.pressure || 0.05);
  return 1;
}

function updateCursor(e: PointerEvent) {
  if (e.pointerType !== 'mouse') {
    cursor.hidden = true;
    return;
  }
  const r = canvas.getBoundingClientRect();
  const d = settings.size * 2 * (r.width / cssW);
  cursor.hidden = false;
  cursor.style.width = cursor.style.height = `${Math.max(4, d)}px`;
  cursor.style.left = `${e.clientX}px`;
  cursor.style.top = `${e.clientY}px`;
}

canvas.addEventListener('pointerdown', (e) => {
  if (engine.replaying) return;
  if (e.pointerType === 'pen') penSeen = true;
  if (penSeen && e.pointerType === 'touch') return; // palm rejection once a stylus was used
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (activePointer !== null) return;
  closeSheets();
  activePointer = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  engine.beginStroke({
    tool: settings.tool,
    size: settings.size,
    water: settings.water / 100,
    pigment: settings.pigment / 100,
    color,
    seed: (Math.random() * 1e9) | 0,
  });
  const [x, y] = toSim(e);
  engine.addPoint(x, y, pressureOf(e));
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  updateCursor(e);
  if (e.pointerId !== activePointer) return;
  const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  for (const ev of list.length ? list : [e]) {
    const [x, y] = toSim(ev);
    engine.addPoint(x, y, pressureOf(ev));
  }
});

const endPointer = (e: PointerEvent) => {
  if (e.pointerId !== activePointer) return;
  activePointer = null;
  engine.endStroke();
  refreshButtons();
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { cursor.hidden = true; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ------------------------------------------------------------------ sheets
const sheets = { color: $('#sheet-color'), brush: $('#sheet-brush'), more: $('#sheet-more') };
const sheetButtons = { color: $('#btn-color'), brush: $('#btn-brush'), more: $('#btn-more') };
type SheetName = keyof typeof sheets;

function closeSheets() {
  for (const k of Object.keys(sheets) as SheetName[]) {
    sheets[k].hidden = true;
    sheetButtons[k].classList.remove('on');
  }
}

function toggleSheet(name: SheetName) {
  const open = sheets[name].hidden;
  closeSheets();
  if (open) {
    sheets[name].hidden = false;
    sheetButtons[name].classList.add('on');
    if (name === 'color') mixer.resize();
  }
}

for (const k of Object.keys(sheets) as SheetName[]) sheetButtons[k].addEventListener('click', () => toggleSheet(k));
stage.addEventListener('pointerdown', (e) => { if (e.target === stage) closeSheets(); });

// ------------------------------------------------------------------ tools
const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('.tool')];
function setTool(t: ToolId) {
  settings.tool = t;
  toolButtons.forEach((b) => b.classList.toggle('on', Number(b.dataset.tool) === t));
  save();
}
toolButtons.forEach((b) => b.addEventListener('click', () => setTool(Number(b.dataset.tool) as ToolId)));
setTool(settings.tool);

// ------------------------------------------------------------------ colours
const paletteEl = $('#palette');
const swatch = $('.swatch');
const paletteButtons = PALETTE.map((p, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = p.name;
  b.setAttribute('aria-label', p.name);
  b.style.background = cssColor(p.rgb);
  b.addEventListener('click', () => selectColor(p, i));
  paletteEl.append(b);
  return b;
});

function selectColor(c: PigmentLatent, index: number) {
  color = c;
  settings.colorIndex = index;
  paletteButtons.forEach((b, i) => b.classList.toggle('on', i === index));
  swatch.style.background = cssColor(latentToRgb(c));
  mixer.color = c;
  if (settings.tool !== 0) setTool(0);
  save();
}

const mixer = new Mixer($<HTMLCanvasElement>('#mixer'));
const mixHint = $('#mix-hint');
const hints = {
  paint: 'Farbe wählen und auf die Fläche tupfen.',
  smudge: 'Durch die Farben ziehen, um sie zu mischen.',
  pick: 'Auf eine Mischung tippen, um damit zu malen.',
};
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('#mix-mode button')];
function setMixMode(m: 'paint' | 'smudge' | 'pick') {
  mixer.mode = m;
  modeButtons.forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  mixHint.textContent = hints[m];
}
modeButtons.forEach((b) => b.addEventListener('click', () => setMixMode(b.dataset.mode as 'paint')));
mixer.onPick = (c) => {
  selectColor(c, -1);
  setMixMode('paint');
};
$('#mix-clear').addEventListener('click', () => mixer.clear());
selectColor(color, settings.colorIndex);

// ------------------------------------------------------------------ sliders
function bindSlider(id: string, key: keyof Settings, fmt: (v: number) => string, apply: (v: number) => void) {
  const input = $<HTMLInputElement>(id);
  const out = input.parentElement!.querySelector('output')!;
  const sync = () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    input.style.setProperty('--p', `${((v - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
  };
  input.value = String(settings[key]);
  sync();
  input.addEventListener('input', () => {
    const v = Number(input.value);
    (settings[key] as number) = v;
    sync();
    apply(v);
    save();
  });
  return (v: number) => { input.value = String(v); (settings[key] as number) = v; sync(); apply(v); save(); };
}

const pct = (v: number) => `${v}%`;
const setSize = bindSlider('#in-size', 'size', (v) => `${v}`, () => {});
bindSlider('#in-water', 'water', pct, () => {});
bindSlider('#in-pigment', 'pigment', pct, () => {});
bindSlider('#in-dry', 'dry', (v) => `${drySpeed(v).toFixed(1)}×`, (v) => engine.setDrySpeed(drySpeed(v)));
bindSlider('#in-edge', 'edge', pct, (v) => { sim.params.edge = (v / 100) * 0.8; });
bindSlider('#in-gran', 'gran', pct, (v) => { sim.params.granulation = (v / 100) * 1.4; engine.invalidate(); });

const paperButtons = [...document.querySelectorAll<HTMLButtonElement>('#paper-type button')];
function setPaper(t: PaperType) {
  settings.paper = t;
  paperButtons.forEach((b) => b.classList.toggle('on', Number(b.dataset.paper) === t));
  engine.setPaper(t);
  save();
}
paperButtons.forEach((b) => b.addEventListener('click', () => setPaper(Number(b.dataset.paper) as PaperType)));
setPaper(settings.paper);

// ------------------------------------------------------------------ actions
const btnUndo = $<HTMLButtonElement>('#btn-undo');
const btnRedo = $<HTMLButtonElement>('#btn-redo');
const btnGen = $<HTMLButtonElement>('#btn-gen');
const btnReplay = $<HTMLButtonElement>('#btn-replay');
const replayBox = $('#replay');
const replayBar = $('#replay .bar');
const statusBox = $('#status');

function refreshButtons() {
  btnUndo.disabled = !engine.canUndo;
  btnRedo.disabled = !engine.canRedo;
  btnGen.disabled = engine.replaying || engine.generating;
  btnReplay.disabled = engine.replaying || engine.generating;
  replayBox.hidden = !engine.replaying;
}
engine.onChange = refreshButtons;
refreshButtons();

btnUndo.addEventListener('click', () => engine.undo());
btnRedo.addEventListener('click', () => engine.redo());
$('#btn-clear').addEventListener('click', () => { engine.clear(); closeSheets(); });
btnGen.addEventListener('click', () => { engine.generative(); closeSheets(); });
btnReplay.addEventListener('click', () => { engine.startReplay(); closeSheets(); });
$('#replay-stop').addEventListener('click', () => engine.stopReplay());

$('#btn-export').addEventListener('click', async () => {
  try {
    const blob = await sim.exportPNG(2);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    a.download = `aquarell-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.png`;
    a.href = url;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    alert((err as Error).message);
  }
  engine.invalidate();
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) engine.redo(); else engine.undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    engine.redo();
  } else if (!mod) {
    const k = e.key.toLowerCase();
    if (k === 'b') setTool(0);
    else if (k === 'w') setTool(1);
    else if (k === 's') setTool(2);
    else if (k === 'x') setTool(3);
    else if (k === '[') setSize(Math.max(2, settings.size - 2));
    else if (k === ']') setSize(Math.min(90, settings.size + 2));
    else if (k === 'escape') closeSheets();
  }
});

window.addEventListener('resize', () => { layoutCanvas(); engine.invalidate(); });

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  const box = $('#error');
  box.hidden = false;
  box.textContent = 'Die Grafikkarte hat den WebGL-Kontext verloren. Bitte Seite neu laden.';
});

// ------------------------------------------------------------------ main loop
let slowFrames = 0;
let last = performance.now();
function loop(now: number) {
  const dt = now - last;
  last = now;
  // keep 60 fps on weak GPUs: drop to one simulation step per frame when frames get slow
  if (engine.busy) {
    if (dt > 22) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
    if (slowFrames > 20 && engine.stepsPerFrame > 1) { engine.stepsPerFrame = 1; slowFrames = 0; }
  }
  engine.frame();
  statusBox.hidden = !engine.busy || engine.replaying;
  (statusBox.querySelector('.label') as HTMLElement).textContent = engine.generating ? 'malt…' : 'trocknet…';
  if (engine.replaying) replayBar.style.width = `${(engine.replayProgress * 100).toFixed(1)}%`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// debugging / automation hook
(window as unknown as { aquarell: unknown }).aquarell = { engine, sim, PALETTE, mixer };
