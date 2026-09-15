/*
  hero 空态的那一行字。

  **这是 `vendor/dsh/skeleton/HeroShell.module.css` 的接线。** 那份 CSS 231 行、逐字搬进来
  之后一直没人 import，于是 `.root` / `.stack` / `.headline` / `.titleGroup` 这四条一直空转。
  DOM 结构照上游 `EmptyHero.tsx` 的 `HeroShell`：`.root` → `.stack` → `.headline` →
  `.titleGroup` → 一个装文字的 `<span>`。

  **鲸鱼标记和工作区芯片都不画。** 上游 `.headline` 里领头的是 `FishLogo`（`EmptyHero.tsx`
  里那套 SMIL morph），而 `FishLogo` 在 NOTICE.md 的「没搬什么」里点了名——那是别人的品牌，
  照抄不合适，另造一个更不合适：hero 的整个作用是「这里还什么都没有」，塞一个自制标记进去
  只会让人以为这是个功能入口。`.fish*` 和 `.workspace*` 因此继续空转，CSS 逐字留着
  （重新同步上游时才不用对 diff）。

  **上游在 hero 下把头整个藏起来（`.headerHidden`），我们不藏。** 上游那一档是「新会话」——
  还没有对象，头里没有可说的东西；我们这一档是一条**已经存在**的对话，只是一条记录都没落盘。
  它有标题、有 CLI、有工作目录、有「返回列表」的面包屑和属性菜单——藏了头，用户就没有退路
  也看不到自己在哪。
*/
import css from "../../vendor/dsh/skeleton/HeroShell.module.css";

/**
 * 居中栈里的那行标题。
 *
 * @param headline - 一句话，说明这个空是怎么回事。
 * @returns 一棵 `.root`，由 `ConversationRoot.module.css` 的
 * `.root[data-phase='hero'] .scrollBody` 摆到栏中央。
 */
export function ConversationHero({ headline }: { headline: string }) {
  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline}>
          {/* 上游把文字单独包一层，好让标题和角标各自可寻址；角标我们没有，包装保留。 */}
          <span className={css.titleGroup}>
            {/*
              **`textAlign: center` 是上游没有的一行，因为我们的标题是一句话，它的是六个字。**
              `.headline` / `.titleGroup` 靠 `justify-content: center` 居中，那管的是
              **flex 项的摆放**；一旦文字在项**内部**换行，第二行就按默认的左对齐排——
              [实测] 400px 宽下这句话折成两行，第二行贴左，读起来像没对齐的 bug。
              上游那句短到永远不换行，所以撞不上。
            */}
            <span style={{ textAlign: "center" }}>{headline}</span>
          </span>
        </div>
        {/* 输入卡不在这里——它是 `.composerStack` 的下一个孩子，见 ConversationContent。 */}
        <div className={css.body} />
      </div>
    </div>
  );
}
