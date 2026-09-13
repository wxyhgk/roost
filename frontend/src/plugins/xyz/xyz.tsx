import { useEffect, useRef, useState } from "react";
import "./3dmol-setup";
import * as $3Dmol from "3dmol";
import type { EditorPlugin } from "../../shared/editor";
import { t } from "@roost/i18n";

type MolViewer = {
  addModel: (s: string, fmt: string) => unknown;
  setStyle: (sel: object, style: object) => void;
  zoomTo: (sel?: object) => void;
  center: (sel?: object) => void;
  render: () => void;
  clear: () => void;
  resize: () => void;
  getCanvas: () => HTMLCanvasElement;
  /** 与 3Dmol GLViewer.getView 一致: [mx,my,mz,zoom,qx,qy,qz,qw] */
  getView: () => number[];
  /** 10 元数组时会额外设置 rotationGroup.position.x/y(3Dmol 2.5.5 的 setView 支持) */
  setView: (view: number[]) => void;
};

const mol = $3Dmol as unknown as {
  createViewer: (el: HTMLElement, config?: object) => MolViewer;
};

const CPK: Record<string, string> = {
  H: "#ffffff", C: "#909090", N: "#3050f8", O: "#ff0d0d",
  F: "#90e050", Na: "#ab5cf2", Cl: "#1ff01f", S: "#ffff30",
  Li: "#cc80ff", B: "#ffb5b5", P: "#ff8000", Br: "#a62929",
  I: "#940094", K: "#8f6911", Ca: "#3dff00", Mg: "#8aff00",
  Al: "#bfa6a6", Si: "#f0c8a0",
};

function parseXyz(content: string): { comment: string; atoms: { el: string }[] } | null {
  const lines = content.split("\n");
  if (lines.length < 3) return null;
  const count = parseInt(lines[0].trim(), 10);
  if (isNaN(count) || count <= 0) return null;
  const comment = lines[1]?.trim() ?? "";
  const atoms: { el: string }[] = [];
  for (let i = 0; i < count; i++) {
    const line = lines[2 + i];
    if (!line) break;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) break;
    atoms.push({ el: parts[0] });
  }
  if (atoms.length === 0) return null;
  return { comment, atoms };
}

// 单位四元数旋转向量: v' = v + 2*cross(q.xyz, cross(q.xyz, v) + w*v)
function applyQuat(
  q: [number, number, number, number],
  v: [number, number, number],
): [number, number, number] {
  let [qx, qy, qz, qw] = q;
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  qx /= n;
  qy /= n;
  qz /= n;
  qw /= n;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

function XyzPreview({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<MolViewer | null>(null);
  // center()/zoomTo() 之后 modelGroup 的基准位置(分子质心在原点),
  // 以及累积在 rotationGroup 上的平移量(绕分子自转的关键)。
  const basePosRef = useRef<[number, number, number] | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);

  // 把平移偏移从 modelGroup 搬到 rotationGroup: 画面逐像素不变,
  // 但旋转轴心回到分子中心。3Dmol 的 translateScene 只改 modelGroup,
  // 平移后直接旋转会绕画布中心公转, 所以每次左键旋转前先 rebalance。
  const rebasePivotToMolecule = () => {
    const viewer = viewerRef.current;
    const base = basePosRef.current;
    if (!viewer || !base) return;
    try {
      const v = viewer.getView();
      if (!Array.isArray(v) || v.length < 8 || v.some((n) => !Number.isFinite(n))) return;
      const t: [number, number, number] = [v[0] - base[0], v[1] - base[1], v[2] - base[2]];
      if (t[0] * t[0] + t[1] * t[1] + t[2] * t[2] < 1e-12) return;
      const w = applyQuat([v[4], v[5], v[6], v[7]], t);
      panRef.current.x += w[0];
      panRef.current.y += w[1];
      viewer.setView([
        base[0], base[1], base[2], v[3] + w[2],
        v[4], v[5], v[6], v[7],
        panRef.current.x, panRef.current.y,
      ]);
    } catch {
      // 降级: 保持 3Dmol 默认行为
    }
  };

  const resetView = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      viewer.center();
      viewer.zoomTo();
      viewer.render();
      const v = viewer.getView();
      if (Array.isArray(v) && v.length >= 8) {
        basePosRef.current = [v[0], v[1], v[2]];
        panRef.current = { x: 0, y: 0 };
        viewer.setView([v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], 0, 0]);
      }
      setError(null);
    } catch {
      // 忽略, 保持当前画面
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    const raf = requestAnimationFrame(() => {
      if (disposed) return;
      try {
        const bg =
          getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim() ||
          "#000000";
        const viewer = mol.createViewer(el, { backgroundColor: bg });
        viewerRef.current = viewer;
        viewer.addModel(content, "xyz");
        viewer.setStyle({}, {
          sphere: { colorscheme: "element", radius: 0.25 },
          stick: { colorscheme: "element", radius: 0.08 },
        });

        // 3Dmol 自带居中+缩放: center 负责旋转中心, zoomTo 负责适配大小。
        // 记录基准位置, 后续 rebase 靠它判断 modelGroup 是否被平移过。
        viewer.center();
        viewer.zoomTo();
        viewer.render();
        const v0 = viewer.getView();
        if (Array.isArray(v0) && v0.length >= 8) {
          basePosRef.current = [v0[0], v0[1], v0[2]];
        }
        panRef.current = { x: 0, y: 0 };
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

    const onContextMenu = (e: Event) => e.preventDefault();
    // 左键按下(旋转)前先把轴心 rebalance 回分子中心; 触屏单指旋转同理。
    // 3Dmol 监听器挂在 canvas 上先执行(只做状态快照, 旋转分支不受影响),
    // 这里挂在容器上冒泡执行, 顺序不影响正确性。
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) rebasePivotToMolecule();
    };
    const onTouchStart = () => rebasePivotToMolecule();
    const onDoubleClick = () => resetView();
    el.addEventListener("contextmenu", onContextMenu);
    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("dblclick", onDoubleClick);

    const ro = new ResizeObserver(() => {
      viewerRef.current?.resize();
    });
    ro.observe(el);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("dblclick", onDoubleClick);
      viewerRef.current?.clear();
      viewerRef.current = null;
      basePosRef.current = null;
      panRef.current = { x: 0, y: 0 };
    };
  }, [content]);

  const parsed = parseXyz(content);
  if (!parsed) {
    return (
      <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-body leading-[1.55]">
        {content}
      </pre>
    );
  }

  const counts: Record<string, number> = {};
  for (const a of parsed.atoms) counts[a.el] = (counts[a.el] ?? 0) + 1;

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        {parsed.comment && (
          <span className="truncate text-caption font-medium text-text">{parsed.comment}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={resetView}
            title={t.misc.xyz.resetTitle}
            className="rounded px-1.5 py-0.5 font-mono text-xs text-text-dim hover:bg-bg-hover hover:text-text"
          >
            {t.misc.xyz.reset}
          </button>
          {Object.entries(counts).map(([el, n]) => (
            <span
              key={el}
              className="flex items-center gap-1 rounded bg-bg-hover px-1.5 py-0.5 text-xs font-mono text-text"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: CPK[el] ?? "#8e8e93" }}
              />
              {el}×{n}
            </span>
          ))}
        </span>
      </div>
      {error && (
        <div className="shrink-0 px-3 py-1.5 text-body leading-[1.45] text-danger">
          3Dmol error: {error}
        </div>
      )}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}

export const xyzPlugin: EditorPlugin = {
  match: (f) => /\.xyz$/i.test(f),
  language: "XYZ",
  extensions: () => [],
  preview: (content) => <XyzPreview content={content} />,
};
