/**
 * **整个应用只建一个 3Dmol viewer，永不销毁。** 它住在一个 host div 里，挂载时把这个 div
 * 搬进当前落点，卸载时只把它摘下来。
 *
 * 不这么做的代价不是「慢一点」，是**把终端拖垮**。3Dmol 2.5.5 的 GLViewer 构造时挂了四样
 * 东西，一样都收不回来（`bind()` 每次产生新函数又没存下来，removeEventListener 无从下手，
 * 整个库里只有 4 处 removeEventListener）：
 *
 *     document.body.addEventListener('mouseup',  this._handleMouseUp.bind(this));
 *     document.body.addEventListener('touchend', this._handleMouseUp.bind(this));
 *     window.addEventListener("resize", this.resize.bind(this));
 *     this.divwatcher = new ResizeObserver(this.resize.bind(this));
 *
 * 而且**它没有任何释放 WebGL 上下文的 API**——loseContext / forceContextLoss / destroy
 * 一个都没有，`clear()` 只做 removeAllModels。文件预览弹窗每换一个文件就重挂一次，于是
 * 每开一次 3D 预览就永久多占一个上下文。
 *
 * 这正好撞上 features/terminal/xtermEngine.ts 里记着的那条约束：浏览器同时能给的 WebGL
 * 上下文大约 16 个，超了会回收**最老的**——被回收的就是终端的渲染器，掉回 DOM 渲染器之后
 * 又慢又撕裂。更糟的是 `tryWebgl()` 那条「切回前台时重新申请」的自愈路径也一并被堵死，
 * 因为泄漏的 viewer 永远不还。
 *
 * **不要改用 `viewer.setContainer()`。** 它走 initContainer，每调一次就把 canvas 上那 7 个
 * 鼠标监听（mousedown/touchstart/wheel/mousemove/touchmove/contextmenu/webglcontextlost）
 * 再挂一遍。自己搬 host div 能绕开，因为 `viewer.container` 指向的始终是同一个对象。
 *
 * 做成工厂而不是模块级单例，是为了让「挂载多少次都只建一个」这条性质能被测到——测试各造
 * 一个自己的宿主，不必去重置全局状态。
 */
export type MolViewer = {
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
  setBackgroundColor: (color: string, alpha?: number) => void;
};

export type ViewerHost = {
  /** 把宿主搬到 mount 下并交出那个唯一的 viewer。`owner` 用来认领，见 release。 */
  acquire(mount: HTMLElement, owner: object, background: string): MolViewer;
  /** 只有当前占着宿主的那个 owner 才摘得动——否则会把它从接管者身上抢走。 */
  release(owner: object): void;
};

export function createViewerHost(create: (host: HTMLElement, config: object) => MolViewer): ViewerHost {
  let host: HTMLDivElement | null = null;
  let viewer: MolViewer | null = null;
  let current: object | null = null;

  return {
    acquire(mount, owner, background) {
      if (!host) {
        host = document.createElement("div");
        // 落点是 relative 的，inset:0 铺满它；3Dmol 按 container 的 client 尺寸算画布。
        host.style.cssText = "position:absolute;inset:0;";
      }
      current = owner;
      mount.appendChild(host);
      if (!viewer) viewer = create(host, { backgroundColor: background });
      // 复用之后主题不再跟着重建走，每次进来显式对一次。
      else viewer.setBackgroundColor(background);
      return viewer;
    },
    release(owner) {
      if (current !== owner) return;
      current = null;
      // 几何和模型该放掉；上下文和监听器留着，那才是省下来的东西。
      try { viewer?.clear(); } catch { /* 画面已经没了，清不掉也无所谓 */ }
      host?.remove();
    },
  };
}
