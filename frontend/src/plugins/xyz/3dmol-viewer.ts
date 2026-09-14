/**
 * **`StructureViewer` 的 3Dmol 实现。** 这个文件是唯一认识 3Dmol 的地方（除了它自己的
 * 宿主 viewer-host.ts）；换查看器时删掉它、换一个实现同一个契约的文件即可，预览组件
 * 不用动。
 *
 * 之所以把轴心校正、球棍样式、背景色都塞进来：它们全是**为了迁就 3Dmol 的行为**而存在的，
 * 换一个查看器就没有意义了。留在组件里的话，换实现时得先把它们一条条辨认出来。
 */
import "./3dmol-setup";
import * as $3Dmol from "3dmol";
import { createViewerHost, type MolViewer } from "./viewer-host";
import { toXyz, type Structure } from "../../shared/chemistry/structure";
import type { StructureView, StructureViewer, ViewerOptions } from "../../shared/chemistry/viewer";

const mol = $3Dmol as unknown as {
  createViewer: (el: HTMLElement, config?: object) => MolViewer;
};

// 唯一的那个宿主。为什么只能有一个，见 viewer-host.ts 顶部。
const viewerHost = createViewerHost((el, config) => mol.createViewer(el, config));

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

export const dmolViewer: StructureViewer = {
  mount(host: HTMLElement, options: ViewerOptions): StructureView {
    // 认领令牌：宿主只认它，别人摘不走，见 viewer-host.ts 的 release。
    const owner = {};
    const viewer = viewerHost.acquire(host, owner, options.background);
    /*
      这里显式量一次就够，**不要再自己挂 ResizeObserver**。3Dmol 的 GLViewer 构造时
      已经有一个 divwatcher 观察同一个 host（还有一个 window resize 监听和一个
      IntersectionObserver），我们再挂一个只是让同一件事每帧干两遍——而 resize() 里是
      `renderer.setSize()` 加整帧 render()，setSize 会重新分配绘制缓冲，缩放弹窗时这
      不便宜。宿主被搬到尺寸不同的落点时 divwatcher 同样会响，覆盖得到。
    */
    viewer.resize();

    // center()/zoomTo() 之后 modelGroup 的基准位置(分子质心在原点),
    // 以及累积在 rotationGroup 上的平移量(绕分子自转的关键)。
    let basePos: [number, number, number] | null = null;
    let pan = { x: 0, y: 0 };

    // 把平移偏移从 modelGroup 搬到 rotationGroup: 画面逐像素不变,
    // 但旋转轴心回到分子中心。3Dmol 的 translateScene 只改 modelGroup,
    // 平移后直接旋转会绕画布中心公转, 所以每次左键旋转前先 rebalance。
    const rebasePivotToMolecule = () => {
      if (!basePos) return;
      try {
        const v = viewer.getView();
        if (!Array.isArray(v) || v.length < 8 || v.some((n) => !Number.isFinite(n))) return;
        const t: [number, number, number] = [v[0] - basePos[0], v[1] - basePos[1], v[2] - basePos[2]];
        if (t[0] * t[0] + t[1] * t[1] + t[2] * t[2] < 1e-12) return;
        const w = applyQuat([v[4], v[5], v[6], v[7]], t);
        pan.x += w[0];
        pan.y += w[1];
        viewer.setView([
          basePos[0], basePos[1], basePos[2], v[3] + w[2],
          v[4], v[5], v[6], v[7],
          pan.x, pan.y,
        ]);
      } catch {
        // 降级: 保持 3Dmol 默认行为
      }
    };

    const resetView = () => {
      viewer.center();
      viewer.zoomTo();
      viewer.render();
      const v = viewer.getView();
      if (Array.isArray(v) && v.length >= 8) {
        basePos = [v[0], v[1], v[2]];
        pan = { x: 0, y: 0 };
        viewer.setView([v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], 0, 0]);
      }
    };

    // 手势归实现所有：它们是在给 3Dmol 打补丁，不是调用方的 UI 策略。
    const onContextMenu = (e: Event) => e.preventDefault();
    // 左键按下(旋转)前先把轴心 rebalance 回分子中心; 触屏单指旋转同理。
    // 3Dmol 监听器挂在 canvas 上先执行(只做状态快照, 旋转分支不受影响),
    // 这里挂在容器上冒泡执行, 顺序不影响正确性。
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) rebasePivotToMolecule();
    };
    const onTouchStart = () => rebasePivotToMolecule();
    const onDoubleClick = () => {
      try { resetView(); } catch { /* 忽略, 保持当前画面 */ }
    };
    host.addEventListener("contextmenu", onContextMenu);
    host.addEventListener("mousedown", onMouseDown);
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("dblclick", onDoubleClick);

    return {
      show(structure: Structure) {
        viewer.clear();
        // 3Dmol 只吃文本，所以在**适配器这一侧**转一道；调用方给的是 Structure。
        // 代价是 structure.bonds 在这儿丢了：标准 XYZ 装不下键，3Dmol 会按距离重猜。
        viewer.addModel(toXyz(structure), "xyz");
        viewer.setStyle({}, {
          sphere: { colorscheme: "element", radius: 0.25 },
          stick: { colorscheme: "element", radius: 0.08 },
        });
        // 3Dmol 自带居中+缩放: center 负责旋转中心, zoomTo 负责适配大小。
        // 记录基准位置, 后续 rebase 靠它判断 modelGroup 是否被平移过。
        resetView();
      },
      resetView,
      resize() {
        viewer.resize();
      },
      setBackground(color: string) {
        viewer.setBackgroundColor(color);
      },
      dispose() {
        host.removeEventListener("contextmenu", onContextMenu);
        host.removeEventListener("mousedown", onMouseDown);
        host.removeEventListener("touchstart", onTouchStart);
        host.removeEventListener("dblclick", onDoubleClick);
        viewerHost.release(owner);
      },
    };
  },
};
