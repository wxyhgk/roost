# 在纯 shell 里顺口问一句，不用开 TUI。
#
# 用法：在 ~/.zshrc 里 `source /Users/virtualized/Code/roost/scripts/ask-hook.zsh`
#
# ── 为什么挂在 command_not_found_handler 上 ──────────────────────────────────
#
# 因为它**只在 shell 已经确定「这不是命令」时才触发**。你打真命令时，这里一行都不跑：
# 零延迟、零外发、零成本。这是整个设计里最要紧的一点——任何放在输入路径上的判断
# （每行都先问一下模型）都会毁掉终端的手感，而终端是整个产品里对延迟最敏感的地方。
#
# ── 判据是量出来的，不是拍的 ─────────────────────────────────────────────────
#
# 2026-09-22 拿这台机器上的真实语料量过：
#
#   · 打给 agent 的中文句子 592 行 → 首词能被 `command -v` 解析成命令的：**0 行**
#     所以「含中文 = 问题」在这台机器上是确定性的，不是启发式。
#   · 真敲过的命令 105 行 → 首词解析不出来的 8 行，全部是**没装的程序**
#     （lscpu / speedtest-cli）或 typo（waa）。这些掉进钩子，但它们不是问题。
#
# 所以钩子里真正要分的是：**一句要问的话** vs **一个打错或没装的命令名**。
#
# ── 这个文件会改一项 shell 选项：nonomatch ──────────────────────────────────
#
# **不改的话，最常见的那种打法直接废掉。** `?` 是 zsh 的通配符，所以 `这个怎么弄?`
# 在 glob 展开那一步就失败了，钩子**根本没机会跑**——实测就是这么发现的：
#
#     默认(nomatch)  zsh:1: no matches found: 这个怎么弄?      ← 钩子没被调用
#     nonomatch      钩子收到整行，中文那条判据生效
#
# 代价只有一处，而且方向是往 bash 靠：通配符没匹配到东西时，zsh 默认整条命令不执行，
# nonomatch 则把模式原样传给命令，由命令自己报错——**bash 一直就是后者**：
#
#     默认(nomatch)  zsh:1: no matches found: *.txt          ← ls 根本没跑
#     nonomatch      ls: *.txt: No such file or directory
#     bash           ls: *.txt: No such file or directory
#
# 不想要这个改动就设 `ASK_KEEP_NOMATCH=1` 再 source，那时中文问句请以全角「？」结尾，
# 或者用 `? ` 前缀——半角问号那条路是走不通的。
(( ${+ASK_KEEP_NOMATCH} )) || setopt nonomatch

# ── 拿不准时照常报错 ────────────────────────────────────────────────────────
#
# 这是安全方向。猜错成「问题」的代价是：你想装个软件，它却去问了个模型；
# 猜错成「命令」的代价只是看到一行 command not found，和没装这个钩子一模一样。
# 所以只有证据充分才当问题，其余一律退回 zsh 原样的行为。

# 谁来回答。`claude -p` 是一次性的无 TUI 调用，正合这个场景；
# 想换成 codex / omp / 自己的脚本，改这一个变量即可。
: ${ASK_CMD:=claude}
: ${ASK_ARGS:=-p}

# 明确问一句：`? 这句话`。判据猜错时的逃生口——**必须有**，否则误判就没有退路了。
alias '?'='_ask_now'
_ask_now() { _ask_run "$*"; }

_ask_run() {
  local question=$1
  if ! command -v -- "$ASK_CMD" >/dev/null 2>&1; then
    print -ru2 -- "ask: 找不到 $ASK_CMD（用 ASK_CMD 指定别的）"
    return 127
  fi
  "$ASK_CMD" ${=ASK_ARGS} -- "$question"
}

# 看起来像「一句要问的话」吗。只认证据，拿不准返回 1。
_ask_looks_like_question() {
  local line=$1

  # ① 含中文 → 问题。592 行实测零反例：中文首词不可能是命令。
  [[ $line == *[一-鿿]* ]] && return 0

  # ② 以问号结尾（半角或全角）→ 问题。
  [[ $line == *'?' || $line == *'？' ]] && return 0

  # ③ 下面都是「像命令」的证据，见到就**不当问题**（退回原样报错）。
  local -a words
  words=(${(z)line})
  # 单个词：lscpu / waa 这种，是没装或打错，不是问题。
  (( ${#words} < 3 )) && return 1
  local w
  for w in $words; do
    # 带路径、带选项、带赋值、带重定向——都是命令的长相。
    [[ $w == -* || $w == */* || $w == *=* || $w == '~'* ]] && return 1
    [[ $w == '|' || $w == '>' || $w == '<' || $w == '&&' || $w == ';' ]] && return 1
  done

  # ④ 剩下的是「三个以上的词、没有任何命令特征」。这一格**故意不当问题**：
  #    `brew install codex` 正好长这样，而它是命令不是问题。
  #    英文自然语言想被认出来，用 `? 你的问题`。等攒够真实误判样本再放宽，
  #    那时候手上有数据，比现在凭空定规则强。
  return 1
}

command_not_found_handler() {
  local line="$*"
  if _ask_looks_like_question "$line"; then
    _ask_run "$line"
    return $?
  fi
  # 和 zsh 原样的行为逐字一致：同样的措辞、同样的退出码。
  print -ru2 -- "zsh: command not found: $1"
  return 127
}
