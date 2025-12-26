import React, { useMemo } from "react";
import type { CircuitType, FaultType } from "../logic/electrical";
import { clamp } from "../logic/electrical";

interface CircuitViewProps {
  circuitType: CircuitType;
  loadCount: number;
  switchClosed: boolean;
  onToggleSwitch: () => void;

  sourceV: number;
  hasFlow: boolean;
  elementPowers: number[];
  branchCurrents?: number[];
  faults: FaultType[];
}

type Pt = { x: number; y: number };

const TOP_Y = 150;
const RETURN_Y = 240;

export default function CircuitView(props: CircuitViewProps) {
  const {
    circuitType,
    loadCount,
    switchClosed,
    onToggleSwitch,
    sourceV,
    hasFlow,
    elementPowers,
    branchCurrents,
    faults,
  } = props;

  // Visual speed only
  const speed = useMemo(() => clamp(0.6 + sourceV / 18, 0.6, 2.2), [sourceV]);

  // Non-parallel loop (simple/series)
  const loopPath: Pt[] = useMemo(() => {
    return [
      { x: 100, y: TOP_Y }, // after battery
      { x: 140, y: TOP_Y }, // to switch
      { x: 220, y: TOP_Y }, // after switch
      { x: 700, y: TOP_Y }, // to right side
      { x: 700, y: RETURN_Y }, // down
      { x: 60, y: RETURN_Y }, // return
      { x: 60, y: TOP_Y }, // up to battery
      { x: 100, y: TOP_Y },
    ];
  }, []);

  // Parallel layout constants (horizontal branches between rails)
  const PAR = useMemo(
    () => ({
      rightMostX: 700 - 35,
      spacingX: 70,
      yCenter: (TOP_Y + RETURN_Y) / 2,
      loadHalf: 25, // rotated load half-height (Load rect becomes ~50px tall)
    }),
    []
  );

  // Parallel branch paths should be FULL loops: battery -> switch -> top rail -> branch -> return -> battery
  const parallelLoopPaths: Pt[][] = useMemo(() => {
    const paths: Pt[][] = [];

    for (let i = 0; i < loadCount; i++) {
      const x = PAR.rightMostX - i * PAR.spacingX;

      paths.push([
        // FEED: battery -> switch
        { x: 100, y: TOP_Y },
        { x: 140, y: TOP_Y },
        { x: 220, y: TOP_Y },

        // Top rail out to the far right (so dots traverse the whole rail)
        { x: 700, y: TOP_Y },

        // Back to this branch, then down through the branch to return
        { x, y: TOP_Y },
        { x, y: RETURN_Y },

        // Return back to battery
        { x: 60, y: RETURN_Y },
        { x: 60, y: TOP_Y },
        { x: 100, y: TOP_Y },
      ]);
    }

    return paths;
  }, [loadCount, PAR]);

  // Dot count for non-parallel modes
  const dotCount = useMemo(() => {
    if (!hasFlow) return 0;

    const iApprox =
      elementPowers.reduce((a, b) => a + b, 0) / Math.max(sourceV, 0.1);

    return clamp(Math.round(iApprox * 2), 3, 28);
  }, [hasFlow, elementPowers, sourceV]);

  return (
    <svg
      viewBox="0 0 800 360"
      width="100%"
      height="100%"
      className="circuitSvg"
    >
      {/* Battery + short feed */}
      <Battery x={70} y={TOP_Y} />
      <line x1={100} y1={TOP_Y} x2={140} y2={TOP_Y} className="wire" />

      {/* Switch */}
      <Switch
        x={180}
        y={TOP_Y}
        closed={switchClosed}
        onClick={onToggleSwitch}
      />

      {/* Circuit layouts */}
      {circuitType === "simple" && (
        <SimpleCircuit
          loadCount={loadCount}
          powers={elementPowers}
          faults={faults}
        />
      )}

      {circuitType === "series" && (
        <SeriesCircuit
          loadCount={loadCount}
          powers={elementPowers}
          faults={faults}
        />
      )}

      {circuitType === "parallel" && (
        <ParallelCircuit
          loadCount={loadCount}
          powers={elementPowers}
          faults={faults}
        />
      )}

      {/* Return path (common) */}
      <line x1="60" y1={RETURN_Y} x2="700" y2={RETURN_Y} className="wire" />
      <line x1="60" y1={RETURN_Y} x2="60" y2={TOP_Y} className="wire" />

      {/* Electron dots */}
      {hasFlow &&
        switchClosed &&
        circuitType !== "parallel" &&
        dotCount > 0 && (
          <ElectronDots path={loopPath} count={dotCount} speed={speed} />
        )}

      {hasFlow && switchClosed && circuitType === "parallel" && (
        <ParallelElectronDots
          loopPaths={parallelLoopPaths}
          branchCurrents={branchCurrents ?? new Array(loadCount).fill(0)}
          speed={speed}
        />
      )}
    </svg>
  );
}

/* =======================
   SVG subcomponents
   ======================= */

function Battery({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <line x1={x} y1={y - 24} x2={x} y2={y + 24} className="wire thick" />
      <line x1={x + 14} y1={y - 16} x2={x + 14} y2={y + 16} className="wire" />
      <text x={x - 18} y={y + 45} textAnchor="end" className="label">
        Battery
      </text>
    </g>
  );
}

function Switch({
  x,
  y,
  closed,
  onClick,
}: {
  x: number;
  y: number;
  closed: boolean;
  onClick: () => void;
}) {
  const left = x - 30;
  const right = x + 30;

  return (
    <g onClick={onClick} style={{ cursor: "pointer" }}>
      {/* fixed terminals */}
      <circle cx={left} cy={y} r={4} className="node" />
      <circle cx={right} cy={y} r={4} className="node" />

      {/* contact arm */}
      {closed ? (
        <line x1={left} y1={y} x2={right} y2={y} className="wire" />
      ) : (
        <line x1={left} y1={y} x2={right - 12} y2={y - 14} className="wire" />
      )}

      <text x={x} y={y + 28} textAnchor="middle" className="label">
        Switch
      </text>
    </g>
  );
}

function faultBadge(f: FaultType) {
  switch (f) {
    case "open":
      return "OPEN";
    case "short":
      return "SHORT";
    case "high":
      return "HIGH";
    default:
      return "";
  }
}

function Load({
  x,
  y,
  label,
  powerW,
  fault,
}: {
  x: number;
  y: number;
  label: string;
  powerW: number;
  fault: FaultType;
}) {
  const glow = clamp(powerW / 20, 0, 1);
  const badge = faultBadge(fault);

  return (
    <g>
      <rect
        x={x - 25}
        y={y - 15}
        width={50}
        height={30}
        rx={6}
        ry={6}
        className="load"
        style={{ opacity: 0.35 + glow * 0.65 }}
      />
      {glow > 0.02 && (
        <rect
          x={x - 25}
          y={y - 15}
          width={50}
          height={30}
          rx={6}
          ry={6}
          className="loadGlow"
          style={{ opacity: glow }}
        />
      )}
      <text x={x} y={y + 5} textAnchor="middle" className="loadLabel">
        {label}
      </text>

      {badge && (
        <text x={x} y={y - 20} textAnchor="middle" className="faultBadge">
          {badge}
        </text>
      )}
    </g>
  );
}

/* =======================
   Circuit layouts
   ======================= */

function SimpleCircuit({
  loadCount,
  powers,
  faults,
}: {
  loadCount: number;
  powers: number[];
  faults: FaultType[];
}) {
  const startX = 260;
  const spacing = 90;

  return (
    <g>
      <line x1={220} y1={TOP_Y} x2={startX - 25} y2={TOP_Y} className="wire" />
      {Array.from({ length: loadCount }).map((_, i) => {
        const x = startX + i * spacing;
        return (
          <g key={i}>
            <Load
              x={x}
              y={TOP_Y}
              label={`Load ${i + 1}`}
              powerW={powers[i] ?? 0}
              fault={faults[i] ?? "normal"}
            />
            {/* wire between loads */}
            {i < loadCount - 1 && (
              <line
                x1={x + 25}
                y1={TOP_Y}
                x2={x + spacing - 25}
                y2={TOP_Y}
                className="wire"
              />
            )}
          </g>
        );
      })}
      <line
        x1={startX + (loadCount - 0.5) * spacing - 20}
        y1={TOP_Y}
        x2={700}
        y2={TOP_Y}
        className="wire"
      />
      <line x1={700} y1={TOP_Y} x2={700} y2={RETURN_Y} className="wire" />
    </g>
  );
}

function SeriesCircuit({
  loadCount,
  powers,
  faults,
}: {
  loadCount: number;
  powers: number[];
  faults: FaultType[];
}) {
  const startX = 280;
  const spacing = 90;

  const loadY = TOP_Y;
  return (
    <g>
      <line x1={220} y1={loadY} x2={startX - 25} y2={loadY} className="wire" />

      {Array.from({ length: loadCount }).map((_, i) => {
        const x = startX + i * spacing;
        return (
          <g key={i}>
            <Load
              x={x}
              y={loadY}
              label={`Load ${i + 1}`}
              powerW={powers[i] ?? 0}
              fault={faults[i] ?? "normal"}
            />
            {i < loadCount - 1 && (
              <line
                x1={x + 25}
                y1={loadY}
                x2={x + spacing - 25}
                y2={loadY}
                className="wire"
              />
            )}
          </g>
        );
      })}

      {/* series exit to right side */}
      <line
        x1={startX + (loadCount - 0.5) * spacing - 20}
        y1={loadY}
        x2={700}
        y2={loadY}
        className="wire"
      />
      <line x1={700} y1={loadY} x2={700} y2={RETURN_Y} className="wire" />
    </g>
  );
}

function ParallelCircuit({
  loadCount,
  powers,
  faults,
}: {
  loadCount: number;
  powers: number[];
  faults: FaultType[];
}) {
  const rightMostX = 700 - 35;
  const spacingX = 70;

  // Center branches between + rail (TOP_Y) and return rail (RETURN_Y)
  const yCenter = (TOP_Y + RETURN_Y) / 2;

  // Load is 50x30; when rotated 90°, its vertical height becomes ~50px
  const loadHalf = 25;

  return (
    <g>
      {/* Top rail */}
      <line x1={220} y1={TOP_Y} x2={700} y2={TOP_Y} className="wire" />

      {/* Right side drop to return */}
      <line x1={700} y1={TOP_Y} x2={700} y2={RETURN_Y} className="wire" />

      {/* Branches (inserted right-to-left) */}
      {Array.from({ length: loadCount }).map((_, i) => {
        const x = rightMostX - i * spacingX;

        return (
          <g key={i}>
            {/* Branch wire down to load */}
            <line
              x1={x}
              y1={TOP_Y}
              x2={x}
              y2={yCenter - loadHalf}
              className="wire"
            />

            {/* Load (rotated 90° for parallel) */}
            <g transform={`rotate(90 ${x} ${yCenter})`}>
              <Load
                x={x}
                y={yCenter}
                label={`Load ${i + 1}`}
                powerW={powers[i] ?? 0}
                fault={faults[i] ?? "normal"}
              />
            </g>

            {/* Branch wire from load down to return */}
            <line
              x1={x}
              y1={yCenter + loadHalf}
              x2={x}
              y2={RETURN_Y}
              className="wire"
            />
          </g>
        );
      })}
    </g>
  );
}

/* =======================
   Electron dots
   ======================= */

function ElectronDots({
  path,
  count,
  speed,
}: {
  path: Pt[];
  count: number;
  speed: number;
}) {
  const d = `M ${path.map((p) => `${p.x},${p.y}`).join(" L ")} Z`;

  const dur = (3.2 / speed).toFixed(2);
  const dots = Array.from({ length: count }).map((_, i) => i);

  return (
    <g className="dots">
      {dots.map((i) => {
        const delay = (i / dots.length).toFixed(3);
        return (
          <circle key={i} r={3} className="dot">
            <animateMotion
              dur={`${dur}s`}
              repeatCount="indefinite"
              keyTimes="0;1"
              keySplines="0.3 0.0 0.7 1.0"
              begin={`${-delay * parseFloat(dur)}s`}
              path={d}
            />
          </circle>
        );
      })}
    </g>
  );
}

function ParallelElectronDots({
  loopPaths,
  branchCurrents,
  speed,
}: {
  loopPaths: Pt[][];
  branchCurrents: number[];
  speed: number;
}) {
  const maxI = Math.max(...branchCurrents, 0.001);

  return (
    <g className="dots">
      {loopPaths.map((p, idx) => {
        const iFrac = clamp((branchCurrents[idx] ?? 0) / maxI, 0.15, 1);
        const count = Math.round(6 + iFrac * 10);

        const d = `M ${p.map((pt) => `${pt.x},${pt.y}`).join(" L ")} Z`;

        const dur = (3.2 / speed).toFixed(2);
        const dots = Array.from({ length: count }).map((_, i) => i);

        return (
          <g key={idx}>
            {dots.map((i) => {
              const delay = (i / dots.length).toFixed(3);
              return (
                <circle key={i} r={3} className="dot">
                  <animateMotion
                    dur={`${dur}s`}
                    repeatCount="indefinite"
                    keyTimes="0;1"
                    keySplines="0.3 0.0 0.7 1.0"
                    begin={`${-delay * parseFloat(dur)}s`}
                    path={d}
                  />
                </circle>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}
