import { readErrorLog } from "../../../shared/errorLog";
import { useEffect, useRef, useState } from 'react';
import type { TerminalState } from '../useTerminal';
import { t } from "@roost/i18n";
import { writeClipboard } from "../../../shared/clipboard";
type Props = Pick<TerminalState,'diagnostics'|'repaint'|'reloadView'|'viewIssue'>;

/*
  复制出去的东西**要经得起截断**。

  这份 JSON 常被贴进聊天窗口，而那些窗口保留的往往是末尾——于是最要紧的
  renderer 那几行（在开头）每次都被切掉，只剩一段没用的 events 尾巴。所以在最后
  再放一行摘要：无论从哪头截，只要还剩一行，剩的就是能定位问题的那一行。
*/
function diagnosticsText(data: ReturnType<Props['diagnostics']>) {
  /*
    前端自己出的错跟着一起复制出去。它不属于某一个终端，但这份 JSON 已经是「出问题时
    贴给别人看」的那份东西，放别处等于没人会找到。
  */
  const errors = readErrorLog();
  const c = data.current, r = c?.renderer, p = c?.replay;
  const line = c ? [
    `phase=${c.phase}/${c.status}`,
    r ? `grid=${r.cols}x${r.rows} fits=${r.fitsCols}x${r.fitsRows} cell=${r.cellWidth}x${r.cellHeight} painted=${r.paintedWidth} box=${r.width}x${r.height}` : '',
    r ? `viewport=${r.viewportY}/${r.baseY} frozen=${r.frozen} lines=${r.bufferLines}` : '',
    p ? `replay=${p.applied}/${p.received} queued=${p.queued} behind=${p.behind}` : '',
    `active=${c.active} visible=${c.visible} input=${c.inputReady} accel=${c.accel ?? '-'}`,
  ].filter(Boolean).join(' · ') : 'no session';
  const failures = errors.length
    ? '\n\n# 前端最近的错误（新→旧）\n' + errors.map(e =>
        `# ${new Date(e.at).toLocaleTimeString()} [${e.kind}] ${e.text}${e.url ? ' ' + e.url : ''}${e.source ? ' @' + e.source : ''}`).join('\n')
    : '';
  return `${JSON.stringify(data, null, 2)}\n\n# ${line}${failures}\n`;
}

export function TerminalDiagnostics(props: Props) {
  // 每次渲染重取：切换语言后阶段名要跟着变，不能缓存在模块顶层。
  const PHASE: Record<string,string> = t.terminal.diagnostics.phase as Record<string, string>;
  const [open,setOpen]=useState(false),[feedback,setFeedback]=useState('');
  const read=useRef(props.diagnostics);read.current=props.diagnostics;
  const [data,setData]=useState(()=>props.diagnostics());
  useEffect(()=>{if(!open)return;setData(read.current());const timer=setInterval(()=>setData(read.current()),1000);return()=>clearInterval(timer)},[open]);
  const current=data.current,render=current?.renderer,replay=current?.replay;
  // 按钮、提示框、面板是同一组浮层，统一用 text-caption：这一整块都是状态读数，
  // 原来按钮 11 而它撑开的面板 12，差的那 1px 不表示任何东西。
    const errors = readErrorLog();
  return <div className="absolute right-3 top-3 z-[12] max-w-[calc(100%-24px)]" onMouseUp={e=>e.stopPropagation()}>
    <button className="float-right rounded-md border border-border bg-bg-panel/90 px-2 py-1 text-caption text-text-dim hover:text-text" onClick={()=>setOpen(v=>!v)} aria-expanded={open}>{t.terminal.diagnostics.toggle}</button>
    {props.viewIssue&&!open&&<div role="status" className="clear-both mt-9 max-w-80 rounded-md border border-border bg-bg-raised p-3 text-caption text-warning">{props.viewIssue}</div>}
    {open&&<section aria-label={t.terminal.diagnostics.title} className="clear-both mt-9 w-80 max-w-full rounded-lg border border-border bg-bg-panel p-4 text-caption text-text shadow-pop">
      <dl className="grid grid-cols-2 gap-x-2 gap-y-2">
        <dt className="text-text-dim">{t.terminal.diagnostics.phaseLabel}</dt><dd>{PHASE[current?.phase??'']??t.terminal.diagnostics.phaseFallback}</dd>
        <dt className="text-text-dim">{t.terminal.diagnostics.historyLabel}</dt><dd>{current ? current.historyTruncated ? t.terminal.diagnostics.historyTruncated : t.terminal.diagnostics.historyOk : '—'}</dd>
        <dt className="text-text-dim">{t.terminal.diagnostics.gridLabel}</dt><dd>{render?t.terminal.diagnostics.gridSize(render.cols, render.rows):'—'}</dd>
        <dt className="text-text-dim">{t.terminal.diagnostics.viewportLabel}</dt><dd>{render?t.terminal.diagnostics.viewportAt(render.viewportY, render.baseY):'—'}</dd>
        <dt className="text-text-dim">{t.terminal.diagnostics.fitsLabel}</dt><dd>{render?t.terminal.diagnostics.fitsRows(render.fitsRows, render.rows):'—'}</dd>
        <dt className="text-text-dim">{t.terminal.diagnostics.widthLabel}</dt><dd>{render?t.terminal.diagnostics.widthFits(render.paintedWidth, render.width):'—'}</dd>
        <dt className="text-text-dim">{t.terminal.diagnostics.cursorLabel}</dt><dd>{replay?`${replay.applied} / ${replay.received}`:'—'}</dd>
        <dt className="text-text-dim">{t.terminal.diagnostics.queueLabel}</dt><dd>{replay?.queued??0} / {render?.frozen?t.terminal.diagnostics.yes:t.terminal.diagnostics.no}</dd>
      </dl>
      {props.viewIssue&&<p role="status" className="mt-3 text-warning">{props.viewIssue}</p>}
      {/*
        **前端自己出的错要看得见，不能只躺在剪贴板里。** 这份东西最需要它的场合是 iPad——
        而在 iPad 上「复制粘贴发给我」本来就别扭。能直接读出那个地址，才省掉一轮来回。
        列在这儿而不是别处：出问题的人本来就会打开这个面板。
      */}
      {errors.length>0&&<div className="mt-4">
        <p className="text-text-dim">{t.terminal.diagnostics.frontendErrors(errors.length)}</p>
        <ul className="mt-1 space-y-1 font-mono text-caption">
          {errors.slice(0,8).map((e,i)=><li key={i} className="break-all text-warning" data-frontend-error>
            <span className="text-text-dim">{new Date(e.at).toLocaleTimeString()} [{e.kind}]</span> {e.text}{e.url?' '+e.url:''}{e.source?' @'+e.source:''}
          </li>)}
        </ul>
      </div>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={!render} className="rounded border border-border px-2 py-1 hover:bg-bg-hover disabled:opacity-40" onClick={()=>{props.repaint();setData(read.current());setFeedback(t.terminal.diagnostics.repainted)}}>{t.terminal.diagnostics.restore}</button>
        <button className="rounded border border-border px-2 py-1 hover:bg-bg-hover" onClick={()=>{props.reloadView();setFeedback(t.terminal.diagnostics.reconnecting)}}>{t.terminal.diagnostics.reload}</button>
        <button className="rounded border border-border px-2 py-1 hover:bg-bg-hover" onClick={()=>{void writeClipboard(diagnosticsText(read.current())).then(ok=>setFeedback(ok?t.terminal.diagnostics.copied:t.terminal.diagnostics.copyFailed))}}>{t.terminal.diagnostics.copy}</button>
      </div>
      <p className="mt-3 leading-relaxed text-text-dim">{t.terminal.diagnostics.noteRetain}</p>
      <p className="mt-2 text-text-dim">{t.terminal.diagnostics.notePrivacy}</p>
      {feedback&&<p role="status" className="mt-2">{feedback===t.terminal.diagnostics.reconnecting&&current?.phase==='live'?t.terminal.diagnostics.reconnected:feedback}</p>}
    </section>}
  </div>;
}
