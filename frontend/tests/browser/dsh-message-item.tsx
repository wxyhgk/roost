// 隔离的浏览器 fixture：把 vendor/dsh/chat 的 MessageItem 五种视图用假数据各画一遍。
// **不连后端**，`npm run dev --prefix frontend` 之后开
// http://localhost:5173/tests/browser/dsh-message-item.html 就行。
//
// 和 dsh-message-actions 同一个用途：CSS Module 打包、tokens.css 的令牌映射、深浅两套主题，
// 这三样任何一个断了画面当场露馅，而 tsc 看不出来。这里额外盯这个组件特有的几件事：
// 气泡的底色和 max-width（--dsw-specific-bubble / --dsh-chat-content-width 两个新令牌）、
// 引用芯片（projectUserText 把 @文件 / @[会话](dsh-session:…) / /技能 画成芯片，
// **不解析 markdown**）、附件卡片（--dsw-specific-input-major + FileTypeIcon），
// 以及错误态那两行的点色（error 红 / warning 黄）。
//
// 右上角那颗钮切深浅；截图脚本直接改 documentElement.dataset.theme 也行，两条路同一个开关。
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  MessageItem, ModelRetryRow, UnknownSurfaceRow,
  type MessageItemLabels, type ModelRetryLabels,
} from '../../src/vendor/dsh/chat/MessageItem.tsx';
import { MessageIconActions } from '../../src/vendor/dsh/chat/MessageIconActions.tsx';
import type { ClockTranslate } from '../../src/vendor/dsh/chat/message-chrome.ts';
import { ThemeProvider, useTheme } from '../../src/shared/theme';
// tokens.css 平时由 vendor/dsh 的桶入口带进来；这个 fixture 只取 chat/ 下的文件，绕过了那个桶，
// 所以必须自己引一次——否则 --dsw-* 全空，气泡没底色、点没颜色。
import '../../src/vendor/dsh/tokens.css';
import '../../src/index.css';

/* 真接线时这一整组从 @roost/i18n 取；这里写死中文。 */
const labels: MessageItemLabels = {
  extraBlock: '这条消息里还有一块没认出来的内容',
  jsonTruncated: total => `…（共 ${total} 字符，已截断）`,
  turnError: '本回合失败',
  authFailure: '登录已失效，请重新连接后再试。',
  maxTokens: '输出被截断',
  maxTokensHint: '这一回合到达了输出长度上限，后面的内容没有生成。',
};

const retryLabels: ModelRetryLabels = {
  status: ({ label, retry, maximum, seconds }) => `${label}：第 ${retry}/${maximum} 次，${seconds} 秒后`,
  active: '正在重试',
  cancelled: '重试已取消',
  started: '重试已开始',
  scheduled: '已安排重试',
  delay: '等待　',
  failure: '原因　',
  duration: ms => `${(ms / 1000).toFixed(1)} 秒`,
  authFailure: labels.authFailure,
};

const clockDate: ClockTranslate = (key, { y, m, d }) => (
  key === 'clock.ymd' ? `${y} 年 ${m} 月 ${d} 日` : `${m} 月 ${d} 日`
);

const actionLabels = {
  copy: '复制',
  copied: '已复制',
  branch: '从这里分支',
  branchUnavailable: '这条消息不是对话末尾，无法分支',
  clockDate,
};

/* 助手正文走默认的 MarkdownText 时它要的两句文案。 */
const markdownLabels = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '脚注' };

const NOW = Date.now();

/** 正文下面那一行。用户侧时刻在前，助手侧在后，和上游一致。 */
const actionsFor = (clock: 'start' | 'end', time = NOW) => (text: string) => (
  <MessageIconActions text={text} time={time} clock={clock} labels={actionLabels} />
);

const LONG_TEXT = [
  '把 deepseek-harness 的对话 GUI 整片搬进来这件事，最怕的不是哪个组件画不出来，',
  '而是「看着画出来了」——CSS Module 的类名没接上、令牌桥少了一条，页面照样渲染，',
  '只是无色、无边、无间距，而 tsc 全绿。所以每搬一块都配一个这样的 fixture，',
  '用真组件、真样式表、真令牌画一遍，再用 headless Chrome 截一张图看一眼。',
  '这一段特意写长，为的是撑出气泡的换行和 max-width 封顶：气泡吃的是',
  '--dsh-chat-content-width 的 70.2%，那个变量在 tokens.css 里有兜底，没兜底的话',
  'calc() 整条作废，气泡会摊满一整行——那正是这张图要看出来的东西。',
].join('');

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ font: 'var(--dsw-font-xs-13)', color: 'var(--color-text-dim)', margin: '0 0 10px' }}>
        {title}
        {note !== undefined && <span style={{ opacity: 0.7 }}>　—— {note}</span>}
      </h2>
      {children}
    </section>
  );
}

function ThemeSwitch() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={toggleTheme}
      data-fixture="theme-switch"
      style={{
        position: 'fixed', top: 12, right: 16, zIndex: 10,
        padding: '4px 10px', borderRadius: 6,
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-panel)', color: 'var(--color-text)',
        font: 'var(--dsw-font-xs-13)', cursor: 'pointer',
      }}
    >
      {theme === 'dark' ? '切到浅色' : '切到深色'}
    </button>
  );
}

function Fixture() {
  return (
    <div style={{
      // 上游由 ConversationRoot 用 ResizeObserver 发布这个值；fixture 里写死，好让
      // 气泡的 max-width 有个确定的参照（760 × 0.702 ≈ 534px）。
      ['--dsh-conversation-column-width' as string]: '760px',
      width: 760, margin: '0 auto', padding: '24px 24px 80px', color: 'var(--color-text)',
    }}>
      <ThemeSwitch />

      <Section title="一、用户短消息" note="一行，气泡按内容收窄">
        <MessageItem role="user" text="帮我看看 build 为什么把线上页面弄白了" labels={labels}
          actions={actionsFor('start')} />
      </Section>

      <Section title="二、用户长消息 + 引用芯片" note="换行、max-width 封顶；@文件 / @会话 / /技能 画成芯片，markdown 不解析">
        <MessageItem role="user" text={LONG_TEXT} labels={labels} actions={actionsFor('start')} />
        <div style={{ height: 12 }} />
        <MessageItem
          role="user"
          /*
            `@path` 后面必须留空格：上游的 token 正则是 `@[^\s]+`，一路吃到下一个空白为止，
            紧跟中文时会把中文一起吃进芯片（`@a/b.mjs，然后` 整串成了一枚芯片）。
            这是上游行为，不是搬坏了；写在这里免得下一个人当 bug 查。
          */
          text={'照 @[昨天那次排查](dsh-session:abc123) 的结论改 @deploy/publish.mjs ，'
            + '然后跑一遍 /verify 收尾。**这几个星号不该被解析成粗体。**'}
          referenceLabels={['昨天那次排查']}
          skillNames={['verify']}
          referenceSummary="引用了 1 个会话：昨天那次排查"
          labels={labels}
          actions={actionsFor('start')}
        />
      </Section>

      <Section title="三、用户消息 + 附件" note="附件行在气泡上方，右对齐；图标走 FileTypeIcon">
        <MessageItem
          role="user"
          text="这两份一起看"
          attachments={[
            { type: 'file', name: 'publish.mjs', bytes: 8_412 },
            { type: 'file', name: '2026-09-10-white-page.md', bytes: 31_907 },
          ]}
          labels={labels}
          actions={actionsFor('start')}
        />
      </Section>

      <Section title="四、助手正文" note="不套气泡、左对齐；正文走已 vendor 的 MarkdownText">
        <MessageItem
          role="assistant"
          text={'原因是 `npm run build` 只写 frontend/dist，而 Caddy 服务的两个 root 都在\n'
            + '~/.local/share/roost/ 下。构建把 index.html 换成指向新哈希的版本，那些哈希要等\n'
            + '发布才到位——入口脚本 404，页面就白了。\n\n发布用 npm run publish：资产先、外壳后。'}
          markdownLabels={markdownLabels}
          labels={labels}
          actions={actionsFor('end')}
        />
      </Section>

      <Section title="五、错误态" note="回合错误（红点 + code）与鉴权失败（原文被替换掉）">
        <MessageItem
          role="assistant"
          text="我先读一下 deploy/publish.mjs……"
          error={{ kind: 'failed', message: '上游返回 502，连接在 30s 后被对端关闭', code: 'UPSTREAM' }}
          labels={labels}
          actions={actionsFor('end')}
        />
        <div style={{ height: 12 }} />
        <MessageItem
          role="assistant"
          text="正在整理这一轮的结论……"
          error={{ kind: 'failed', message: '这条原始文案应该被 authFailure 顶掉', code: 'AUTH' }}
          labels={labels}
        />
      </Section>

      <Section title="六、max-tokens" note="黄点 + 标题 + 解释，没有 code 那一格">
        <MessageItem
          role="assistant"
          text="……（很长的一段输出，到这里被截断）"
          error={{ kind: 'max-tokens' }}
          labels={labels}
          actions={actionsFor('end')}
        />
      </Section>

      <Section title="七、重试行" note="倒计时那一支带流光；点开看等待时长和失败原因">
        <ModelRetryRow
          retry={2} maximum={5} delayMs={8_000} state="scheduled" active
          failure={{ message: '上游返回 429', code: 'RATE_LIMIT' }} labels={retryLabels}
        />
        <div style={{ height: 8 }} />
        <ModelRetryRow
          retry={5} maximum="∞" delayMs={2_500} state="cancelled" active={false}
          failure={{ message: '这条会被 authFailure 顶掉', code: 'AUTH' }} labels={retryLabels}
        />
      </Section>

      <Section title="八、未知面" note="解析器认不出来的东西，折叠成一块 JSON">
        <UnknownSurfaceRow
          type="tool_use.mcp__unknown"
          payload={{ id: 'toolu_017x', name: 'mcp__unknown', input: { path: '/etc/hosts', limit: 40 } }}
          labels={{ unknownSurface: type => `未支持的内容：${type}`, jsonTruncated: labels.jsonTruncated }}
        />
      </Section>

      <Section title="九、正文之外的块" note="extraBlocks：气泡里正文下面挂一块 JSON">
        <MessageItem
          role="user"
          text="顺便把这个结构也带上"
          extraBlocks={[{ type: 'tool_result', ok: false, detail: { code: 'ENOENT' } }]}
          labels={labels}
          actions={actionsFor('start')}
        />
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><Fixture /></ThemeProvider></StrictMode>,
);
