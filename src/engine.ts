import { StampBuffer, StrokeBuilder, StrokeSettings } from './brush';
import { generate, GenItem } from './generative';
import type { PigmentLatent } from './palette';
import { PaperType, Snapshot, Watercolor } from './sim';

// Everything that changes the painting is logged with the simulation step it happened at.
// The same log drives the time-lapse replay, so replay re-runs the identical simulation.
type Ev =
  | { step: number; a: number; k: 'begin'; s: StrokeSettings }
  | { step: number; a: number; k: 'pt'; x: number; y: number; p: number }
  | { step: number; a: number; k: 'poly'; pts: Float32Array; color: PigmentLatent; water: number; pig: number; seed: number }
  | { step: number; a: number; k: 'clear' }
  | { step: number; a: -1; k: 'param'; drySpeed: number; paper: PaperType };

interface HistEntry { snap: Snapshot; action: number }

interface GenRun { items: GenItem[]; idx: number; start: number; action: number }

interface Replay {
  events: Ev[];
  idx: number;
  step: number;
  end: number;
  rate: number;
  finalSnap: Snapshot;
  savedStep: number;
  savedSpeed: number;
  savedPaper: PaperType;
  builder: StrokeBuilder | null;
}

export class Engine {
  private log: Ev[] = [];
  private dead = new Set<number>(); // undone actions
  private nextAction = 1;
  private undoStack: HistEntry[] = [];
  private redoStack: HistEntry[] = [];
  private stamps = new StampBuffer();
  private stroke: { b: StrokeBuilder; a: number } | null = null;
  private gen: GenRun | null = null;
  private replay: Replay | null = null;
  private activeSteps = 0;
  private dirty = true;
  /** drying speed the user picked (the generator temporarily overrides it) */
  userDrySpeed = 1;
  stepsPerFrame = 2;
  onChange: () => void = () => {};

  constructor(readonly sim: Watercolor, readonly maxUndo: number) {
    this.logParams();
  }

  get canUndo(): boolean { return this.undoStack.length > 0 && !this.replay; }
  get canRedo(): boolean { return this.redoStack.length > 0 && !this.replay; }
  get replaying(): boolean { return !!this.replay; }
  get generating(): boolean { return !!this.gen; }
  get replayProgress(): number {
    const r = this.replay;
    return r ? 1 - (r.end - r.step) / Math.max(1, r.end - (r.events[0]?.step ?? 0)) : 0;
  }
  /** true while paint is still wet / the simulation still runs */
  get busy(): boolean { return this.activeSteps > 0 || !!this.gen; }

  private wake(): void {
    const s = this.sim.params.drySpeed;
    this.activeSteps = Math.ceil(3800 / s) + 300;
    this.dirty = true;
  }

  private logParams(): void {
    this.log.push({ step: this.sim.stepIndex, a: -1, k: 'param', drySpeed: this.sim.params.drySpeed, paper: this.sim.paperType });
  }

  // ---------------------------------------------------------------- actions
  private beginAction(): number {
    const a = this.nextAction++;
    this.undoStack.push({ snap: this.sim.snapshot(), action: a });
    for (const r of this.redoStack) {
      this.sim.release(r.snap);
      this.dead.add(r.action);
    }
    this.redoStack = [];
    while (this.undoStack.length > this.maxUndo) this.sim.release(this.undoStack.shift()!.snap);
    this.onChange();
    return a;
  }

  beginStroke(s: StrokeSettings): void {
    if (this.replay) return;
    this.endStroke();
    const a = this.beginAction();
    this.log.push({ step: this.sim.stepIndex, a, k: 'begin', s });
    this.stroke = { b: new StrokeBuilder(s, this.sim.simScale), a };
  }

  addPoint(x: number, y: number, p: number): void {
    const st = this.stroke;
    if (!st) return;
    this.log.push({ step: this.sim.stepIndex, a: st.a, k: 'pt', x, y, p });
    st.b.add(x, y, p, this.stamps);
  }

  /** Push queued stamps to the GPU (called once per batch of pointer events). */
  flushStroke(): void {
    const st = this.stroke;
    if (!st || this.stamps.count === 0) return;
    this.sim.stamps(this.stamps.data, this.stamps.count, st.b.s.tool, st.b.s.color);
    this.stamps.count = 0;
    this.wake();
  }

  endStroke(): void {
    this.flushStroke();
    this.stroke = null;
  }

  clear(): void {
    if (this.replay) return;
    this.endStroke();
    this.gen = null;
    const a = this.beginAction();
    this.log.push({ step: this.sim.stepIndex, a, k: 'clear' });
    this.sim.clear();
    this.restoreUserSpeed();
    this.dirty = true;
  }

  generative(seed = (Math.random() * 2 ** 31) | 0): void {
    if (this.replay || this.gen) return;
    this.endStroke();
    const a = this.beginAction();
    this.gen = { items: generate(seed, this.sim.w, this.sim.h), idx: 0, start: this.sim.stepIndex, action: a };
    this.wake();
    this.onChange();
  }

  setDrySpeed(v: number): void {
    this.userDrySpeed = v;
    if (!this.gen) this.applySpeed(v);
  }

  private applySpeed(v: number): void {
    if (this.sim.params.drySpeed === v) return;
    this.sim.params.drySpeed = v;
    this.logParams();
    this.wake();
  }

  private restoreUserSpeed(): void {
    this.applySpeed(this.userDrySpeed);
  }

  setPaper(t: PaperType): void {
    if (this.replay || this.sim.paperType === t) return;
    this.sim.setPaper(t);
    this.logParams();
    this.dirty = true;
  }

  undo(): void {
    if (!this.canUndo) return;
    this.endStroke();
    const e = this.undoStack.pop()!;
    if (this.gen && this.gen.action === e.action) {
      this.gen = null;
      this.restoreUserSpeed();
    }
    this.redoStack.push({ snap: this.sim.snapshot(), action: e.action });
    this.sim.restore(e.snap);
    this.sim.release(e.snap);
    this.dead.add(e.action);
    this.wake();
    this.onChange();
  }

  redo(): void {
    if (!this.canRedo) return;
    this.endStroke();
    const e = this.redoStack.pop()!;
    this.undoStack.push({ snap: this.sim.snapshot(), action: e.action });
    this.sim.restore(e.snap);
    this.sim.release(e.snap);
    this.dead.delete(e.action);
    this.wake();
    this.onChange();
  }

  // ---------------------------------------------------------------- generator
  private runGenerator(): void {
    const g = this.gen!;
    const rel = this.sim.stepIndex - g.start;
    while (g.idx < g.items.length && g.items[g.idx].offset <= rel) {
      const it = g.items[g.idx++];
      if (it.kind === 'speed') {
        this.applySpeed(it.drySpeed < 0 ? this.userDrySpeed : it.drySpeed);
      } else {
        this.log.push({ step: this.sim.stepIndex, a: g.action, k: 'poly', pts: it.pts, color: it.color, water: it.water, pig: it.pigment, seed: it.seed });
        this.sim.polygon(it.pts, it.color, it.water, it.pigment, it.seed);
      }
    }
    if (g.idx >= g.items.length) {
      this.gen = null;
      this.wake();
      this.onChange();
    }
  }

  // ---------------------------------------------------------------- replay
  startReplay(): void {
    if (this.replay || this.gen) return;
    this.endStroke();
    const events = this.log.filter((e) => e.a < 0 || !this.dead.has(e.a));
    let start = 0;
    events.forEach((e, i) => { if (e.k === 'clear') start = i; });
    // parameters in effect at the start point
    let speed = 1;
    let paper: PaperType = this.sim.paperType;
    for (let i = 0; i <= start; i++) {
      const e = events[i];
      if (e.k === 'param') { speed = e.drySpeed; paper = e.paper; }
    }
    const list = events.slice(start);
    if (!list.some((e) => e.k === 'pt' || e.k === 'poly')) return;
    const end = this.sim.stepIndex;
    const first = list[0].step;
    this.replay = {
      events: list, idx: 0, step: first, end,
      rate: Math.min(16, Math.max(2, Math.ceil((end - first) / (60 * 14)))),
      finalSnap: this.sim.snapshot(), savedStep: this.sim.stepIndex, savedSpeed: this.sim.params.drySpeed,
      savedPaper: this.sim.paperType, builder: null,
    };
    this.sim.clear();
    this.sim.params.drySpeed = speed;
    if (paper !== this.sim.paperType) this.sim.setPaper(paper);
    this.onChange();
  }

  stopReplay(): void {
    const r = this.replay;
    if (!r) return;
    this.sim.restore(r.finalSnap);
    this.sim.release(r.finalSnap);
    this.sim.stepIndex = r.savedStep;
    this.sim.params.drySpeed = r.savedSpeed;
    if (this.sim.paperType !== r.savedPaper) this.sim.setPaper(r.savedPaper);
    this.replay = null;
    this.dirty = true;
    this.onChange();
  }

  private replayFrame(): void {
    const r = this.replay!;
    for (let k = 0; k < r.rate; k++) {
      while (r.idx < r.events.length && r.events[r.idx].step <= r.step) this.applyReplayEvent(r, r.events[r.idx++]);
      if (r.builder && this.stamps.count) {
        this.sim.stamps(this.stamps.data, this.stamps.count, r.builder.s.tool, r.builder.s.color);
        this.stamps.count = 0;
      }
      if (r.step >= r.end) {
        this.stopReplay();
        return;
      }
      this.sim.step();
      r.step++;
    }
  }

  private applyReplayEvent(r: Replay, e: Ev): void {
    switch (e.k) {
      case 'begin':
        if (r.builder && this.stamps.count) {
          this.sim.stamps(this.stamps.data, this.stamps.count, r.builder.s.tool, r.builder.s.color);
          this.stamps.count = 0;
        }
        r.builder = new StrokeBuilder(e.s, this.sim.simScale);
        break;
      case 'pt':
        r.builder?.add(e.x, e.y, e.p, this.stamps);
        break;
      case 'poly':
        this.sim.polygon(e.pts, e.color, e.water, e.pig, e.seed);
        break;
      case 'clear':
        this.sim.clear();
        break;
      case 'param':
        this.sim.params.drySpeed = e.drySpeed;
        if (e.paper !== this.sim.paperType) this.sim.setPaper(e.paper);
        break;
    }
  }

  // ---------------------------------------------------------------- frame
  frame(): void {
    if (this.replay) {
      this.replayFrame();
      this.sim.render();
      return;
    }
    this.flushStroke();
    const steps = this.gen ? Math.max(this.stepsPerFrame, 4) : this.stepsPerFrame;
    for (let i = 0; i < steps; i++) {
      if (this.gen) this.runGenerator();
      if (this.activeSteps <= 0 && !this.gen) break;
      this.sim.step();
      this.activeSteps--;
      this.dirty = true;
    }
    if (this.dirty) {
      this.sim.render();
      this.dirty = false;
    }
  }

  invalidate(): void {
    this.dirty = true;
  }
}
