export type FaultType = "normal" | "high" | "open" | "short";
export type CircuitType = "simple" | "series" | "parallel";

export interface LoadConfig {
  rUser: number; // user-entered resistance
  fault: FaultType;
}

export interface ElementRow {
  label: string;
  v: number; // volts across element
  i: number; // amps through element (series: same for all)
  r: number; // effective resistance used in math
  p: number; // watts
  status: string;
}

export interface CalcResult {
  sourceV: number;
  totalR: number; // Infinity if open / no current
  totalI: number;
  totalP: number;
  rows: ElementRow[];
  faultNotes: string[]; // short descriptions for right panel
  hasFlow: boolean; // whether electrons should move
  branchCurrents?: number[]; // for parallel animation splitting
  elementPowers: number[]; // per load power (for brightness)
}

const R_SHORT = 0.01; // per spec suggestion :contentReference[oaicite:14]{index=14}
const R_OPEN = Number.POSITIVE_INFINITY;
const R_HIGH_ADD = 5; // per spec example (+5Ω) :contentReference[oaicite:15]{index=15}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function round1(n: number) {
  return Math.round(n * 10) / 10;
}
export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function effectiveResistance(rUser: number, fault: FaultType): number {
  const r = clamp(rUser, 1, 25);
  switch (fault) {
    case "normal":
      return r;
    case "high":
      return r + R_HIGH_ADD;
    case "open":
      return R_OPEN;
    case "short":
      return R_SHORT;
    default:
      return r;
  }
}

export function faultDescription(fault: FaultType): string {
  switch (fault) {
    case "high":
      return "High Resistance: corrosion or poor connection.";
    case "open":
      return "Open Circuit: broken wire or open switch.";
    case "short":
      return "Short Circuit: wire rubbed through to ground.";
    default:
      return "";
  }
}

export function calcCircuit(opts: {
  circuitType: CircuitType;
  sourceV: number;
  switchClosed: boolean;
  loads: LoadConfig[]; // already sliced to active count
}): CalcResult {
  const { circuitType, sourceV, switchClosed, loads } = opts;

  // If switch is open: no current anywhere (acts like open circuit)
  if (!switchClosed) {
    return {
      sourceV,
      totalR: Number.POSITIVE_INFINITY,
      totalI: 0,
      totalP: 0,
      rows: loads.map((l, idx) => ({
        label: `Load ${idx + 1}`,
        v: 0,
        i: 0,
        r: effectiveResistance(l.rUser, l.fault),
        p: 0,
        status: "Switch Open",
      })),
      faultNotes: [],
      hasFlow: false,
      branchCurrents:
        circuitType === "parallel" ? loads.map(() => 0) : undefined,
      elementPowers: loads.map(() => 0),
    };
  }

  const effR = loads.map((l) => effectiveResistance(l.rUser, l.fault));
  const notes: string[] = [];
  loads.forEach((l) => {
    const d = faultDescription(l.fault);
    if (d) notes.push(d);
  });

  if (circuitType === "simple") {
    const r1 = effR[0];
    const totalR = r1;
    const totalI = isFinite(totalR) ? sourceV / totalR : 0;
    const v1 = sourceV; // simple loop
    const p1 = v1 * totalI;

    return {
      sourceV,
      totalR,
      totalI,
      totalP: p1,
      rows: [
        {
          label: "Load 1",
          v: v1,
          i: totalI,
          r: r1,
          p: p1,
          status: loads[0].fault === "normal" ? "Normal" : loads[0].fault,
        },
      ],
      faultNotes: notes,
      hasFlow: totalI > 0.0001,
      elementPowers: [p1],
    };
  }

  if (circuitType === "series") {
    // Any open in series -> total current ~0
    const hasOpen = effR.some((r) => !isFinite(r));
    if (hasOpen) {
      return {
        sourceV,
        totalR: Number.POSITIVE_INFINITY,
        totalI: 0,
        totalP: 0,
        rows: loads.map((l, idx) => ({
          label: `Load ${idx + 1}`,
          v: 0,
          i: 0,
          r: effR[idx],
          p: 0,
          status:
            l.fault === "open"
              ? "Open Circuit"
              : l.fault === "normal"
              ? "Normal"
              : l.fault,
        })),
        faultNotes: notes.length
          ? notes
          : ["Open circuit in series: loop current is ~0 A."],
        hasFlow: false,
        elementPowers: loads.map(() => 0),
      };
    }

    const totalR = effR.reduce((a, b) => a + b, 0);
    const totalI = sourceV / totalR;

    const rows: ElementRow[] = [];
    const powers: number[] = [];
    for (let i = 0; i < loads.length; i++) {
      const v = totalI * effR[i];
      const p = totalI * totalI * effR[i];
      powers.push(p);
      rows.push({
        label: `Load ${i + 1}`,
        v,
        i: totalI,
        r: effR[i],
        p,
        status: loads[i].fault === "normal" ? "Normal" : loads[i].fault,
      });
    }

    return {
      sourceV,
      totalR,
      totalI,
      totalP: rows.reduce((s, r) => s + r.p, 0),
      rows,
      faultNotes: notes,
      hasFlow: totalI > 0.0001,
      elementPowers: powers,
    };
  }

  // parallel
  const branchI: number[] = [];
  const rows: ElementRow[] = [];
  const powers: number[] = [];

  for (let i = 0; i < loads.length; i++) {
    const r = effR[i];
    const iBranch = isFinite(r) ? sourceV / r : 0;
    const p = sourceV * iBranch;
    branchI.push(iBranch);
    powers.push(p);
    rows.push({
      label: `Load ${i + 1}`,
      v: sourceV,
      i: iBranch,
      r,
      p,
      status: loads[i].fault === "normal" ? "Normal" : loads[i].fault,
    });
  }

  const totalI = branchI.reduce((a, b) => a + b, 0);
  const totalR = totalI > 0 ? sourceV / totalI : Number.POSITIVE_INFINITY;
  const totalP = powers.reduce((a, b) => a + b, 0);

  // Add a helpful note if a short exists
  if (loads.some((l) => l.fault === "short")) {
    notes.push(
      "A shorted branch has nearly 0 Ω, so it draws most of the current."
    );
  }

  return {
    sourceV,
    totalR,
    totalI,
    totalP,
    rows,
    faultNotes: notes,
    hasFlow: totalI > 0.0001,
    branchCurrents: branchI,
    elementPowers: powers,
  };
}
