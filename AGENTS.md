# AGENTS.md

本仓库是 DSH 宿主侧插件 `dsh-media-understanding`，注册 `transcribe_audio`（音视频 → 转录文本）与 `video_frames`（视频 → 带时间戳关键帧真图）两个工具。

- 设计、工具契约、配置项、包结构 → `docs/coding-plan.md`：**动工具契约、DSH API 调用或包结构之前先读它**。
- 复审结论、本机实测环境、阻断点 B1–B8 → `docs/coding-plan-review.md`：**接入 profile、跑不通、或怀疑 DSH 版本差异时读它**。

宿主半代码改动，重启 `dsh web` 后才生效。

## 提交身份与署名

每次提交都由维护者本人完成：作者、提交者、commit message，以及**每个文件的每一处**，都只出现维护者身份。

    git config user.name  reamerit
    git config user.email reamer.shi@outlook.com

- 版权声明（`LICENSE`、文件头、`@author`、`SPDX-FileCopyrightText`、`Copyright`）只署维护者。Apache-2.0 `LICENSE` 里 `Copyright [yyyy] [name of copyright owner]` 是模板占位符，保持原样；那份协议的正文措辞是法律条文，不要改。
- 文件名同样只取维护者视角的名字。
- commit message 写平实的说明文字。
- 要清掉的是**归属声明**；`@deepseek-ai/dsh-*`、`openai-responses` 这类技术标识是正文内容，保留。

### 提交前扫描

    git grep --untracked -nIiE 'co-authored-by|(generated|powered|written|created|authored)\s+(with|by)\s+.{0,40}(ai|llm|model|assistant|claude|gpt|chatgpt|copilot|gemini|codex)|noreply@(anthropic|openai)\.com|claude|chatgpt|copilot|gemini|codex|🤖' -- . ':(exclude)AGENTS.md'
    git grep --untracked -nIiE 'copyright\s*(\(c\)|©)?\s*(\[yyyy\]|[0-9]{4})|@author|spdx-filecopyrighttext' -- . ':(exclude)AGENTS.md'
    git ls-files | Select-String -Pattern 'claude|chatgpt|copilot|gemini|codex'
    git config user.name; git config user.email
    git log -1 --format='%an <%ae>%n%cn <%ce>%n%B'

`:(exclude)AGENTS.md` 只豁免本文件自己——那串模式就写在这里。

**完成判据**：第一条零命中；第二条只应命中 `LICENSE` 的模板占位符；第三条零命中；身份只有 `reamerit <reamer.shi@outlook.com>`；message 无署名行。命中就改——文件名、注释、版权行、message 都算——改完重扫，扫干净再提交。

改动扫描模式后，用反向自测确认它还在生效：临时写一行署名，跑第一条，看到命中再删掉。模式失效时它是静默的。

`.gitignore` 已排除 `node_modules/` 与构建产物 `lib/`。
