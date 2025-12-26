import { useMemo, useState } from "react";
import CircuitView from "./components/CircuitView";
import { calcCircuit, clamp, round1, round2 } from "./logic/electrical";
import type { CircuitType, FaultType, LoadConfig, CalcResult } from "./logic/electrical";


type Mode = "demo" | "practice" | "quiz";
type Difficulty = "beginner" | "experienced";

const DEFAULT_LOADS: LoadConfig[] = Array.from({ length: 5 }).map(() => ({
  rUser: 6,
  fault: "normal" as FaultType,
}));

const QUIZ_TOTAL_QUESTIONS = 10;

type Unit = "Ω" | "A" | "V" | "W";

type Part = {
  id: string;
  label: string;
  unit: Unit;
  // symbolic formula, and then a substitution string
  formula: string;
  substitution: string;
  correct: number;
  tol: number;
};

type Question = {
  id: string;
  title: string;
  prompt: string;
  parts: Part[];
  // snapshot + precomputed calc at time of question creation
  snapshot: CircuitSnapshot;
  calc: CalcResult;
};

type CircuitSnapshot = {
  circuitType: CircuitType;
  sourceV: number;
  loadCount: number;
  switchClosed: boolean;
  loads: LoadConfig[];
};

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function parseStudentNumber(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/ohms/g, "")
    .replace(/omega/g, "")
    .replace(/[a-zΩ]/g, " ")
    .trim();
  const m = cleaned.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function withinTol(val: number, correct: number, tol: number) {
  return Math.abs(val - correct) <= tol;
}

function tolFor(unit: Unit) {
  if (unit === "A") return 0.02;
  if (unit === "V") return 0.02;
  if (unit === "Ω") return 0.05;
  return 0.5; // W
}

function fmt(n: number) {
  // keep it readable, not “calculator vomit”
  return Number.isFinite(n) ? String(round2(n)) : "∞";
}

function cloneLoads(loads: LoadConfig[], n: number): LoadConfig[] {
  return loads.slice(0, n).map((l) => ({ rUser: l.rUser, fault: l.fault }));
}

/* =========================
   Question Builder
   ========================= */

function buildQuestion(
  difficulty: Difficulty,
  snap: CircuitSnapshot,
  calc: CalcResult
): Question {
  const id = uid();
  const ct = snap.circuitType;

  const parts: Part[] = [];
  let title = "";
  let prompt = "";

  const Rtotal = calc.totalR;
  const Itotal = calc.totalI;
  const Ptotal = calc.totalP;

  // helpers for formulas/substitution
  const fI = "I = V / Rtotal";
  const sI = `I = ${fmt(snap.sourceV)} / ${fmt(Rtotal)}`;

  const fP = "P = V × I";
  const sP = `P = ${fmt(snap.sourceV)} × ${fmt(Itotal)}`;

  if (difficulty === "beginner") {
    // pick a single-part question that makes sense for the circuit type
    const options: Array<
      "Rtotal" | "Itotal" | "Ptotal" | "Vdrop1" | "Ibranch1"
    > = [];

    options.push("Rtotal", "Itotal", "Ptotal");
    if (ct === "series" && calc.rows.length >= 1) options.push("Vdrop1");
    if (ct === "parallel" && calc.rows.length >= 1) options.push("Ibranch1");

    const pick = options[Math.floor(Math.random() * options.length)];

    if (pick === "Rtotal") {
      title = "Find Total Resistance";
      prompt = "Calculate the total resistance of the circuit.";
      parts.push({
        id: "rtotal",
        label: "Rtotal",
        unit: "Ω",
        formula:
          ct === "parallel"
            ? "1/Rtotal = 1/R1 + 1/R2 + …"
            : ct === "series"
            ? "Rtotal = R1 + R2 + …"
            : "Rtotal = R1",
        substitution:
          ct === "parallel"
            ? `1/Rtotal = ${calc.rows
                .map((r) => (Number.isFinite(r.r) ? `1/${fmt(r.r)}` : "0"))
                .join(" + ")}`
            : ct === "series"
            ? `Rtotal = ${calc.rows.map((r) => fmt(r.r)).join(" + ")}`
            : `Rtotal = ${fmt(calc.rows[0]?.r ?? Rtotal)}`,
        correct: Number.isFinite(Rtotal) ? Rtotal : 0,
        tol: tolFor("Ω"),
      });
    } else if (pick === "Itotal") {
      title = "Find Total Current";
      prompt = "Calculate total current in the circuit.";
      parts.push({
        id: "itotal",
        label: "Itotal",
        unit: "A",
        formula: fI,
        substitution: sI,
        correct: Itotal,
        tol: tolFor("A"),
      });
    } else if (pick === "Ptotal") {
      title = "Find Total Power";
      prompt = "Calculate total power in the circuit.";
      parts.push({
        id: "ptotal",
        label: "Ptotal",
        unit: "W",
        formula: fP,
        substitution: sP,
        correct: Ptotal,
        tol: tolFor("W"),
      });
    } else if (pick === "Vdrop1") {
      const r0 = calc.rows[0];
      title = "Find Voltage Drop (Load 1)";
      prompt = "In a series circuit, voltage drop across a load is V = I × R.";
      parts.push({
        id: "v1",
        label: "V1",
        unit: "V",
        formula: "Vn = I × Rn",
        substitution: `V1 = ${fmt(Itotal)} × ${fmt(r0.r)}`,
        correct: r0.v,
        tol: tolFor("V"),
      });
    } else {
      const r0 = calc.rows[0];
      title = "Find Branch Current (Load 1)";
      prompt = "In a parallel circuit, branch current is In = V / Rn.";
      parts.push({
        id: "i1",
        label: "I1",
        unit: "A",
        formula: "In = V / Rn",
        substitution: `I1 = ${fmt(snap.sourceV)} / ${fmt(r0.r)}`,
        correct: r0.i,
        tol: tolFor("A"),
      });
    }
  } else {
    // Experienced: multi-part full circuit solve
    title = "Full Circuit Calculation";
    prompt =
      ct === "series"
        ? "Solve the series circuit: Rtotal, Itotal, and voltage drop(s)."
        : ct === "parallel"
        ? "Solve the parallel circuit: Rtotal, Itotal, and branch current(s)."
        : "Solve the circuit: Rtotal, Itotal, and power.";

    // Part 1: Rtotal
    parts.push({
      id: "rtotal",
      label: "Rtotal",
      unit: "Ω",
      formula:
        ct === "parallel"
          ? "1/Rtotal = 1/R1 + 1/R2 + …"
          : ct === "series"
          ? "Rtotal = R1 + R2 + …"
          : "Rtotal = R1",
      substitution:
        ct === "parallel"
          ? `1/Rtotal = ${calc.rows
              .map((r) => (Number.isFinite(r.r) ? `1/${fmt(r.r)}` : "0"))
              .join(" + ")}`
          : ct === "series"
          ? `Rtotal = ${calc.rows.map((r) => fmt(r.r)).join(" + ")}`
          : `Rtotal = ${fmt(calc.rows[0]?.r ?? Rtotal)}`,
      correct: Number.isFinite(Rtotal) ? Rtotal : 0,
      tol: tolFor("Ω"),
    });

    // Part 2: Itotal
    parts.push({
      id: "itotal",
      label: "Itotal",
      unit: "A",
      formula: fI,
      substitution: sI,
      correct: Itotal,
      tol: tolFor("A"),
    });

    // Part 3+: per-load based on circuit type
    if (ct === "series") {
      // ask for Vdrops for each load (more boxes = more points, still fair)
      calc.rows.forEach((r, idx) => {
        parts.push({
          id: `v${idx + 1}`,
          label: `V${idx + 1} (Load ${idx + 1})`,
          unit: "V",
          formula: "Vn = I × Rn",
          substitution: `V${idx + 1} = ${fmt(Itotal)} × ${fmt(r.r)}`,
          correct: r.v,
          tol: tolFor("V"),
        });
      });
    } else if (ct === "parallel") {
      calc.rows.forEach((r, idx) => {
        parts.push({
          id: `i${idx + 1}`,
          label: `I${idx + 1} (Load ${idx + 1})`,
          unit: "A",
          formula: "In = V / Rn",
          substitution: `I${idx + 1} = ${fmt(snap.sourceV)} / ${fmt(r.r)}`,
          correct: r.i,
          tol: tolFor("A"),
        });
      });
    } else {
      // simple
      parts.push({
        id: "ptotal",
        label: "Ptotal",
        unit: "W",
        formula: fP,
        substitution: sP,
        correct: Ptotal,
        tol: tolFor("W"),
      });
    }
  }

  // make sure we never generate a question where everything is “0” by design
  // (you said switch open should block questions, so this is mostly fault edge-cases)
  if (parts.every((p) => Math.abs(p.correct) < 0.000001)) {
    // fall back to total resistance question (still valid)
    return buildQuestion("beginner", snap, calc);
  }

  return {
    id,
    title,
    prompt,
    parts,
    snapshot: snap,
    calc,
  };
}

/* =========================
   Quiz Scenario Generator
   ========================= */

function randomStep05(min: number, max: number) {
  const steps = Math.round((max - min) / 0.5);
  const k = Math.floor(Math.random() * (steps + 1));
  return min + k * 0.5;
}

function pickFaultForQuiz(ct: CircuitType, idx: number): FaultType {
  // Keep it challenging but not “everyone answers 0”.
  // - Disallow OPEN in simple/series (too trivial)
  // - Allow OPEN in parallel (branch open is realistic)
  // - Allow at most one SHORT
  const r = Math.random();
  if (r < 0.72) return "normal";
  if (r < 0.87) return "high";

  if (ct === "parallel") {
    // sometimes open branch
    return r < 0.94 ? "open" : "short";
  }

  // series/simple: no open
  return "short";
}

function generateQuizScenario(): CircuitSnapshot {
  const ctPick = Math.random();
  const circuitType: CircuitType =
    ctPick < 0.25 ? "simple" : ctPick < 0.6 ? "series" : "parallel";

  const loadCount =
    circuitType === "simple"
      ? 1
      : ((2 + Math.floor(Math.random() * 4)) as 2 | 3 | 4 | 5);

  const loads: LoadConfig[] = [];
  let shortCount = 0;

  for (let i = 0; i < loadCount; i++) {
    const rUser = randomStep05(1, 25);

    let fault = pickFaultForQuiz(circuitType, i);

    if (fault === "short") {
      shortCount++;
      if (shortCount > 1) fault = "high"; // cap shorts
    }

    loads.push({ rUser, fault });
  }

  // In parallel, avoid the “everything open” scenario
  if (circuitType === "parallel" && loads.every((l) => l.fault === "open")) {
    loads[0].fault = "normal";
  }

  return {
    circuitType,
    sourceV: 12, // keep quiz consistent unless you want random V later
    loadCount,
    switchClosed: true,
    loads,
  };
}

/* =========================
   App
   ========================= */

export default function App() {
  const [mode, setMode] = useState<Mode>("demo");

  // Practice controls
  const [difficulty, setDifficulty] = useState<Difficulty>("beginner");
  const [showFormulas, setShowFormulas] = useState<boolean>(true);

  // Quiz state (in-memory only)
  const [quizStep, setQuizStep] = useState<number>(1);
  const [quizScore, setQuizScore] = useState<number>(0);
  const [quizPossible, setQuizPossible] = useState<number>(0);
  const [quizComplete, setQuizComplete] = useState<boolean>(false);
  const [quizQuestion, setQuizQuestion] = useState<Question | null>(null);

  const [circuitType, setCircuitType] = useState<CircuitType>("simple");
  const [sourceVoltage, setSourceVoltage] = useState<number>(12);

  const [loadCount, setLoadCount] = useState<number>(2);
  const [switchClosed, setSwitchClosed] = useState<boolean>(true);

  const [loads, setLoads] = useState<LoadConfig[]>(DEFAULT_LOADS);

  const controlsLocked = mode === "quiz";

  const activeLoadCount = useMemo(() => {
    if (circuitType === "simple") return 1;
    return clamp(loadCount, 2, 5);
  }, [circuitType, loadCount]);

  const activeLoads = useMemo(
    () => loads.slice(0, activeLoadCount),
    [loads, activeLoadCount]
  );

  const calc = useMemo(() => {
    return calcCircuit({
      circuitType,
      sourceV: sourceVoltage,
      switchClosed,
      loads: activeLoads,
    });
  }, [circuitType, sourceVoltage, switchClosed, activeLoads]);

  function updateLoad(idx: number, patch: Partial<LoadConfig>) {
    setLoads((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  function resetQuiz() {
    setQuizStep(1);
    setQuizScore(0);
    setQuizPossible(0);
    setQuizComplete(false);
    setQuizQuestion(null);
  }

  function applySnapshotToUI(snap: CircuitSnapshot) {
    setCircuitType(snap.circuitType);
    setSourceVoltage(snap.sourceV);
    setLoadCount(snap.loadCount);
    setSwitchClosed(snap.switchClosed);

    // overwrite the first N loads, keep array length 5
    setLoads((prev) => {
      const next = [...prev];
      for (let i = 0; i < 5; i++) {
        if (i < snap.loads.length) next[i] = { ...snap.loads[i] };
      }
      return next;
    });
  }

  function startNextQuizQuestion(step: number) {
    const snap = generateQuizScenario();
    applySnapshotToUI(snap);

    const c = calcCircuit({
      circuitType: snap.circuitType,
      sourceV: snap.sourceV,
      switchClosed: snap.switchClosed,
      loads: snap.loads,
    });

    const diff: Difficulty = step <= 4 ? "beginner" : "experienced";
    const q = buildQuestion(diff, snap, c);

    setQuizQuestion(q);
  }

  // Practice question state
  const [practiceQuestion, setPracticeQuestion] = useState<Question | null>(
    null
  );
  const [practiceAnswers, setPracticeAnswers] = useState<
    Record<string, string>
  >({});
  const [practiceChecked, setPracticeChecked] = useState<boolean>(false);
  const [practicePoints, setPracticePoints] = useState<{
    got: number;
    possible: number;
  } | null>(null);

  function newPracticeQuestion() {
    if (!switchClosed) return;

    const snap: CircuitSnapshot = {
      circuitType,
      sourceV: sourceVoltage,
      loadCount: activeLoadCount,
      switchClosed,
      loads: cloneLoads(loads, activeLoadCount),
    };

    const c = calcCircuit({
      circuitType: snap.circuitType,
      sourceV: snap.sourceV,
      switchClosed: snap.switchClosed,
      loads: snap.loads,
    });

    const q = buildQuestion(difficulty, snap, c);

    setPracticeQuestion(q);
    setPracticeAnswers({});
    setPracticeChecked(false);
    setPracticePoints(null);
  }

  function checkPractice() {
    if (!practiceQuestion) return;

    let got = 0;
    let possible = practiceQuestion.parts.length;

    for (const part of practiceQuestion.parts) {
      const raw = practiceAnswers[part.id] ?? "";
      const n = parseStudentNumber(raw);
      if (n === null) continue;
      if (withinTol(n, part.correct, part.tol)) got += 1;
    }

    setPracticeChecked(true);
    setPracticePoints({ got, possible });
  }

  // Quiz answer state (per question)
  const [quizAnswers, setQuizAnswers] = useState<Record<string, string>>({});
  const [quizChecked, setQuizChecked] = useState<boolean>(false);

  function submitQuizAnswer() {
    if (!quizQuestion) return;

    // grade this question
    let got = 0;
    let possible = quizQuestion.parts.length;

    for (const part of quizQuestion.parts) {
      const raw = quizAnswers[part.id] ?? "";
      const n = parseStudentNumber(raw);
      if (n === null) continue;
      if (withinTol(n, part.correct, part.tol)) got += 1;
    }

    // update totals
    setQuizScore((prev) => prev + got);
    setQuizPossible((prev) => prev + possible);
    setQuizChecked(true);

    // advance after a short delay (so students can see feedback)
    setTimeout(() => {
      const nextStep = quizStep + 1;

      if (quizStep >= QUIZ_TOTAL_QUESTIONS) {
        setQuizComplete(true);
      } else {
        setQuizStep(nextStep);
        setQuizAnswers({});
        setQuizChecked(false);
        startNextQuizQuestion(nextStep);
      }
    }, 600);
  }

  return (
    <div className="appRoot">
      <header className="topBar">
        <div className="titleBlock">
          <div className="appTitle">ElectraSim v1.0 – Student Edition</div>
          <div className="subTitle">System Online</div>
        </div>
        <button className="pillButton" disabled>
          Foreman Console
        </button>
      </header>

      <main className="mainGrid">
        {/* LEFT: Controls */}
        <section className="panel panelBorder">
          <div className="panelHeader">Controls</div>
          <div className="panelBody">
            {/* Mode */}
            <div className="controlGroup">
              <div className="controlLabel">Mode</div>
              <div className="segmented">
                <SegButton
                  active={mode === "demo"}
                  onClick={() => {
                    setMode("demo");
                    setPracticeQuestion(null);
                    resetQuiz();
                  }}
                >
                  Demonstration
                </SegButton>

                <SegButton
                  active={mode === "practice"}
                  onClick={() => {
                    setMode("practice");
                    resetQuiz();
                    setPracticeQuestion(null);
                  }}
                >
                  Practice
                </SegButton>

                <SegButton
                  active={mode === "quiz"}
                  onClick={() => {
                    setMode("quiz");
                    setPracticeQuestion(null);
                    resetQuiz();
                    // question 1
                    startNextQuizQuestion(1);
                  }}
                >
                  Quiz
                </SegButton>
              </div>

              {/* Practice toggles */}
              {mode === "practice" && (
                <>
                  <div className="inlineRow">
                    <span className="controlLabelSmall">Show formulas</span>
                    <input
                      type="checkbox"
                      checked={showFormulas}
                      onChange={() => setShowFormulas((s) => !s)}
                    />
                  </div>

                  <div className="inlineRow">
                    <span className="controlLabelSmall">Difficulty</span>
                    <div className="segmented small">
                      <SegButton
                        active={difficulty === "beginner"}
                        onClick={() => setDifficulty("beginner")}
                      >
                        Beginner
                      </SegButton>
                      <SegButton
                        active={difficulty === "experienced"}
                        onClick={() => setDifficulty("experienced")}
                      >
                        Experienced
                      </SegButton>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="divider" />

            {/* Circuit Type */}
            <div className="controlGroup">
              <div className="controlLabel">Circuit Type</div>
              <div className="segmented">
                <SegButton
                  active={circuitType === "simple"}
                  onClick={() => setCircuitType("simple")}
                  disabled={controlsLocked}
                >
                  Simple
                </SegButton>
                <SegButton
                  active={circuitType === "series"}
                  onClick={() => setCircuitType("series")}
                  disabled={controlsLocked}
                >
                  Series
                </SegButton>
                <SegButton
                  active={circuitType === "parallel"}
                  onClick={() => setCircuitType("parallel")}
                  disabled={controlsLocked}
                >
                  Parallel
                </SegButton>
              </div>

              <div className="controlRow">
                <span className="controlLabelSmall">Loads / Branches</span>
                <input
                  className="slider"
                  type="range"
                  min={2}
                  max={5}
                  step={1}
                  value={activeLoadCount}
                  disabled={circuitType === "simple" || controlsLocked}
                  onChange={(e) => setLoadCount(parseInt(e.target.value, 10))}
                />
                <div className="readout">
                  {circuitType === "simple" ? "N/A" : activeLoadCount}
                </div>
              </div>
            </div>

            <div className="divider" />

            {/* Source */}
            <div className="controlGroup">
              <div className="controlLabel">Source Settings</div>
              <div className="controlRow">
                <span className="controlLabelSmall">Voltage</span>
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={24}
                  step={3}
                  value={sourceVoltage}
                  disabled={controlsLocked}
                  onChange={(e) =>
                    setSourceVoltage(parseInt(e.target.value, 10))
                  }
                />
                <div className="readout">{sourceVoltage} V</div>
              </div>

              <div className="hintText">
                {mode === "quiz"
                  ? "Quiz mode: controls locked."
                  : "Click the switch in the diagram to open / close."}
              </div>
            </div>

            <div className="divider" />

            {/* Loads */}
            <div className="controlGroup">
              <div className="controlLabel">Loads</div>

              {Array.from({ length: activeLoadCount }).map((_, i) => (
                <div key={i} className="loadControlCard">
                  <div className="loadControlHeader">
                    <div className="loadTitle">Load {i + 1}</div>
                    <select
                      className="faultSelect"
                      value={loads[i].fault}
                      disabled={controlsLocked}
                      onChange={(e) =>
                        updateLoad(i, { fault: e.target.value as FaultType })
                      }
                    >
                      <option value="normal">Normal</option>
                      <option value="high">High Resistance</option>
                      <option value="open">Open Circuit</option>
                      <option value="short">Short Circuit</option>
                    </select>
                  </div>

                  <div className="loadControlRow">
                    <span className="controlLabelSmall">Ω</span>
                    <input
                      className="slider"
                      type="range"
                      min={1}
                      max={25}
                      step={0.5}
                      value={loads[i].rUser}
                      disabled={controlsLocked}
                      onChange={(e) =>
                        updateLoad(i, { rUser: parseFloat(e.target.value) })
                      }
                    />
                    <input
                      className="ohmsBox"
                      type="number"
                      min={1}
                      max={25}
                      step={0.5}
                      value={loads[i].rUser}
                      disabled={controlsLocked}
                      onChange={(e) =>
                        updateLoad(i, {
                          rUser: parseFloat(e.target.value || "1"),
                        })
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CENTER: Circuit */}
        <section className="panel panelBorder centerPanel">
          <div className="panelHeader">Circuit Visualization</div>
          <div className="panelBody">
            <CircuitView
              circuitType={circuitType}
              loadCount={activeLoadCount}
              switchClosed={switchClosed}
              onToggleSwitch={() => {
                if (mode === "quiz") return; // locked
                setSwitchClosed((s) => !s);
              }}
              sourceV={sourceVoltage}
              hasFlow={calc.hasFlow}
              elementPowers={calc.elementPowers}
              branchCurrents={calc.branchCurrents}
              faults={activeLoads.map((l) => l.fault)}
            />
          </div>
        </section>

        {/* RIGHT: Outputs */}
        <section className="panel panelBorder">
          <div className="panelHeader">Outputs</div>
          <div className="panelBody">
            <div className="rightBlock">
              <div className="blockTitle">Summary</div>

              <div className="kvRow">
                <span className="kvKey">Circuit</span>
                <span className="kvVal">
                  {circuitType === "simple"
                    ? "Simple circuit (1 load)"
                    : circuitType === "series"
                    ? `Series circuit (${activeLoadCount} loads)`
                    : `Parallel circuit (${activeLoadCount} branches)`}
                </span>
              </div>

              <div className="kvRow">
                <span className="kvKey">Source Voltage</span>
                <span className="kvVal">{round1(calc.sourceV)} V</span>
              </div>

              <div className="kvRow">
                <span className="kvKey">Total Resistance</span>
                <span className="kvVal">
                  {isFinite(calc.totalR) ? `${round2(calc.totalR)} Ω` : "∞ Ω"}
                </span>
              </div>

              <div className="kvRow">
                <span className="kvKey">Total Current</span>
                <span className="kvVal">{round2(calc.totalI)} A</span>
              </div>

              <div className="kvRow">
                <span className="kvKey">Total Power</span>
                <span className="kvVal">{round1(calc.totalP)} W</span>
              </div>

              <div className="divider subtle" />

              <div className="blockTitle">Per-Element Table</div>
              <div className="tableWrap">
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>Element</th>
                      <th>V (V)</th>
                      <th>I (A)</th>
                      <th>R (Ω)</th>
                      <th>P (W)</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calc.rows.map((r) => (
                      <tr key={r.label}>
                        <td>{r.label}</td>
                        <td>{round2(r.v)}</td>
                        <td>{round2(r.i)}</td>
                        <td>{isFinite(r.r) ? round2(r.r) : "∞"}</td>
                        <td>{round1(r.p)}</td>
                        <td>{prettyStatus(r.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="divider subtle" />

              <div className="blockTitle">Status</div>
              {calc.faultNotes.length === 0 ? (
                <div className="statusText">No faults selected.</div>
              ) : (
                <ul className="statusList">
                  {calc.faultNotes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}

              {!switchClosed && (
                <div className="statusText">
                  Switch is open → circuit current is ~0 A.
                </div>
              )}

              {/* Ohm's Law Triangle (keep SVG as requested) */}
              <div className="divider subtle" />
              <div className="ohmTriangleBox">
                <svg
                  width="140"
                  height="110"
                  viewBox="0 0 140 110"
                  role="img"
                  aria-label="Ohm's Law Triangle"
                >
                  <polygon
                    points="70,10 130,100 10,100"
                    fill="rgba(120, 255, 180, 0.10)"
                    stroke="rgba(120, 255, 180, 0.45)"
                    strokeWidth="2"
                  />
                  <line
                    x1="40"
                    y1="60"
                    x2="100"
                    y2="60"
                    stroke="rgba(120, 255, 180, 0.45)"
                    strokeWidth="2"
                  />
                  <line
                    x1="70"
                    y1="60"
                    x2="70"
                    y2="100"
                    stroke="rgba(120, 255, 180, 0.45)"
                    strokeWidth="2"
                  />
                  <text
                    x="70"
                    y="48"
                    textAnchor="middle"
                    fill="rgba(220,255,235,0.9)"
                    fontSize="22"
                    fontFamily="system-ui, Arial"
                  >
                    V
                  </text>
                  <text
                    x="45"
                    y="88"
                    textAnchor="middle"
                    fill="rgba(220,255,235,0.9)"
                    fontSize="22"
                    fontFamily="system-ui, Arial"
                  >
                    I
                  </text>
                  <text
                    x="95"
                    y="88"
                    textAnchor="middle"
                    fill="rgba(220,255,235,0.9)"
                    fontSize="22"
                    fontFamily="system-ui, Arial"
                  >
                    R
                  </text>
                </svg>
              </div>
            </div>
          </div>
        </section>

        {/* BOTTOM */}
        <section className="panel panelBorder bottomPanel">
          <div className="panelHeader">
            {mode === "quiz"
              ? `Quiz Question ${quizStep} / ${QUIZ_TOTAL_QUESTIONS}`
              : "Show the Math"}
          </div>

          <div className="panelBody">
            {mode === "demo" && (
              <MathPanel
                circuitType={circuitType}
                sourceV={calc.sourceV}
                rows={calc.rows}
                totalR={calc.totalR}
                totalI={calc.totalI}
                faultNotes={calc.faultNotes}
              />
            )}

            {mode === "practice" && (
              <PracticePanel
                showFormulas={showFormulas}
                switchClosed={switchClosed}
                question={practiceQuestion}
                answers={practiceAnswers}
                setAnswers={setPracticeAnswers}
                checked={practiceChecked}
                points={practicePoints}
                onNew={newPracticeQuestion}
                onCheck={checkPractice}
              />
            )}

            {mode === "quiz" && (
              <QuizPanel
                showFormulas={true} // quiz always shows formulas per your spec
                question={quizQuestion}
                answers={quizAnswers}
                setAnswers={setQuizAnswers}
                checked={quizChecked}
                onSubmit={submitQuizAnswer}
                quizComplete={quizComplete}
                quizScore={quizScore}
                quizPossible={quizPossible}
              />
            )}
          </div>
        </section>
      </main>

      <footer className="footerBar">
        <span className="footerText">
          ElectraSim v1.0 • Standalone • No sign-in • No data saved
        </span>
      </footer>
    </div>
  );
}

/* =========================
   UI helpers
   ========================= */

function SegButton({
  active,
  onClick,
  children,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`segBtn ${active ? "active" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function prettyStatus(s: string) {
  if (s === "high") return "High Res";
  if (s === "open") return "Open Circuit";
  if (s === "short") return "Short Circuit";
  if (s === "normal") return "Normal";
  return s;
}

/* =========================
   Bottom Panel Components
   ========================= */

function PracticePanel(props: {
  showFormulas: boolean;
  switchClosed: boolean;
  question: Question | null;
  answers: Record<string, string>;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  checked: boolean;
  points: { got: number; possible: number } | null;
  onNew: () => void;
  onCheck: () => void;
}) {
  const {
    showFormulas,
    switchClosed,
    question,
    answers,
    setAnswers,
    checked,
    points,
    onNew,
    onCheck,
  } = props;

  if (!switchClosed) {
    return (
      <div className="hintText">
        <strong>Close the switch to begin.</strong>
        <div style={{ marginTop: 8, opacity: 0.8 }}>
          Practice questions are disabled when the switch is open.
        </div>
      </div>
    );
  }

  return (
    <div className="practiceWrap">
      <div className="practiceHeaderRow">
        <div>
          <div style={{ fontWeight: 700 }}>
            {question ? question.title : "Practice"}
          </div>
          <div className="hintText">
            {question
              ? question.prompt
              : "Click “New Question” to generate a practice problem from the current circuit."}
          </div>
        </div>

        <div className="practiceButtons">
          <button className="secondaryButton" onClick={onNew}>
            New Question
          </button>
          <button
            className="primaryButton"
            onClick={onCheck}
            disabled={!question}
          >
            Check Answer
          </button>
        </div>
      </div>

      {question && (
        <div className="qaGrid">
          {question.parts.map((p) => {
            const raw = answers[p.id] ?? "";
            const n = parseStudentNumber(raw);
            const ok = checked && n !== null && withinTol(n, p.correct, p.tol);

            return (
              <div key={p.id} className="qaCard">
                <div className="qaLabelRow">
                  <div className="qaLabel">{p.label}</div>
                  {checked && (
                    <div className={`qaBadge ${ok ? "ok" : "bad"}`}>
                      {ok ? "Correct" : "Check"}
                    </div>
                  )}
                </div>

                {showFormulas && (
                  <>
                    <div className="qaFormula">{p.formula}</div>
                    <div className="qaSub">{p.substitution}</div>
                  </>
                )}

                <div className="qaInputRow">
                  <input
                    className="qaInput"
                    value={raw}
                    onChange={(e) =>
                      setAnswers((prev) => ({
                        ...prev,
                        [p.id]: e.target.value,
                      }))
                    }
                    placeholder={`Enter ${p.unit}`}
                  />
                  <div className="qaUnit">{p.unit}</div>
                </div>

                {checked && !ok && (
                  <div className="qaHint">
                    Correct ≈ {fmt(p.correct)} {p.unit}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {points && (
        <div className="quizResult" style={{ marginTop: 10 }}>
          <div>
            Score: {points.got} / {points.possible}
          </div>
          <div>
            Percentage: {Math.round((points.got / points.possible) * 100)}%
          </div>
        </div>
      )}
    </div>
  );
}

function QuizPanel(props: {
  showFormulas: boolean;
  question: Question | null;
  answers: Record<string, string>;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  checked: boolean;
  onSubmit: () => void;
  quizComplete: boolean;
  quizScore: number;
  quizPossible: number;
}) {
  const {
    showFormulas,
    question,
    answers,
    setAnswers,
    checked,
    onSubmit,
    quizComplete,
    quizScore,
    quizPossible,
  } = props;

  if (quizComplete) {
    const pct =
      quizPossible > 0 ? Math.round((quizScore / quizPossible) * 100) : 0;

    return (
      <div className="quizResult">
        <div>
          Score: {quizScore} / {quizPossible}
        </div>
        <div>Percentage: {pct}%</div>
        <div className="hintText">Screenshot this result.</div>
      </div>
    );
  }

  if (!question) {
    return <div className="hintText">Generating quiz…</div>;
  }

  return (
    <div className="practiceWrap">
      <div className="practiceHeaderRow">
        <div>
          <div style={{ fontWeight: 700 }}>{question.title}</div>
          <div className="hintText">{question.prompt}</div>
        </div>

        <div className="practiceButtons">
          <button className="primaryButton" onClick={onSubmit}>
            Submit Answer
          </button>
        </div>
      </div>

      <div className="qaGrid">
        {question.parts.map((p) => {
          const raw = answers[p.id] ?? "";
          const n = parseStudentNumber(raw);
          const ok = checked && n !== null && withinTol(n, p.correct, p.tol);

          return (
            <div key={p.id} className="qaCard">
              <div className="qaLabelRow">
                <div className="qaLabel">{p.label}</div>
                {checked && (
                  <div className={`qaBadge ${ok ? "ok" : "bad"}`}>
                    {ok ? "Correct" : "Check"}
                  </div>
                )}
              </div>

              {showFormulas && (
                <>
                  <div className="qaFormula">{p.formula}</div>
                  <div className="qaSub">{p.substitution}</div>
                </>
              )}

              <div className="qaInputRow">
                <input
                  className="qaInput"
                  value={raw}
                  onChange={(e) =>
                    setAnswers((prev) => ({ ...prev, [p.id]: e.target.value }))
                  }
                  placeholder={`Enter ${p.unit}`}
                />
                <div className="qaUnit">{p.unit}</div>
              </div>

              {checked && !ok && (
                <div className="qaHint">
                  Correct ≈ {fmt(p.correct)} {p.unit}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="hintText" style={{ marginTop: 10, opacity: 0.75 }}>
        Partial credit is awarded per box. Units are ignored.
      </div>
    </div>
  );
}

/* =========================
   Original MathPanel
   ========================= */

function MathPanel({
  circuitType,
  sourceV,
  rows,
  totalR,
  totalI,
  faultNotes,
}: {
  circuitType: CircuitType;
  sourceV: number;
  rows: {
    label: string;
    v: number;
    i: number;
    r: number;
    p: number;
    status: string;
  }[];
  totalR: number;
  totalI: number;
  faultNotes: string[];
}) {
  const rList = rows.map((r) => r.r);
  const rText = rList.map((r) => (isFinite(r) ? round2(r) : "∞")).join(" + ");

  const invTerms = rList
    .map((r) => (isFinite(r) ? `1/${round2(r)}` : "0"))
    .join(" + ");

  const vDrops = rows.map((r) => `${r.label}: ${round2(r.v)}V`).join(" | ");
  const iBranches = rows.map((r) => `${r.label}: ${round2(r.i)}A`).join(" | ");

  return (
    <div className="mathGrid">
      <div className="mathSteps">
        <div className="stepLine">
          <span className="stepLabel">Step 1:</span>
          <span className="stepText">
            Find Total Resistance{" "}
            {circuitType === "series" && (
              <>
                <div className="mathMini">Rtotal = R1 + R2 + …</div>
                <div className="mathMini">
                  Rtotal = {rText} ={" "}
                  {isFinite(totalR) ? `${round2(totalR)}Ω` : "∞Ω"}
                </div>
              </>
            )}
            {circuitType === "parallel" && (
              <>
                <div className="mathMini">1/Rtotal = 1/R1 + 1/R2 + …</div>
                <div className="mathMini">1/Rtotal = {invTerms}</div>
                <div className="mathMini">
                  Rtotal = {isFinite(totalR) ? `${round2(totalR)}Ω` : "∞Ω"}
                </div>
              </>
            )}
            {circuitType === "simple" && (
              <>
                <div className="mathMini">Rtotal = R1</div>
                <div className="mathMini">
                  Rtotal = {isFinite(totalR) ? `${round2(totalR)}Ω` : "∞Ω"}
                </div>
              </>
            )}
          </span>
        </div>

        <div className="stepLine">
          <span className="stepLabel">Step 2:</span>
          <span className="stepText">
            Find Total Current (I = V / Rtotal)
            <div className="mathMini">
              I = {round2(sourceV)} / {isFinite(totalR) ? round2(totalR) : "∞"}{" "}
              = {round2(totalI)} A
            </div>
          </span>
        </div>

        <div className="stepLine">
          <span className="stepLabel">Step 3:</span>
          <span className="stepText">
            {circuitType === "series"
              ? "Voltage drops: Vn = I × Rn"
              : circuitType === "parallel"
              ? "Branch currents: In = V / Rn"
              : "Load values"}
            <div className="mathMini">
              {circuitType === "series" ? vDrops : iBranches}
            </div>
          </span>
        </div>

        <div className="stepLine">
          <span className="stepLabel">Step 4:</span>
          <span className="stepText">
            Check sums
            <div className="mathMini">
              {circuitType === "series"
                ? "Sum of voltage drops ≈ Source voltage"
                : circuitType === "parallel"
                ? "Sum of branch currents ≈ Total current"
                : "N/A"}
            </div>
            {faultNotes.length > 0 && (
              <div className="mathMini">Fault note(s): {faultNotes[0]}</div>
            )}
          </span>
        </div>
      </div>

      <div className="mathControls">
        <div className="mathModeHint">
          Demonstration mode: values and substitutions shown live.
        </div>
        <div className="hintText">
          Select Practice mode or Quiz mode to test your knowledge.
        </div>
      </div>
    </div>
  );
}
