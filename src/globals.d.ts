/**
 * 触发各官方包的 `declare module '@deepseek-ai/cordis'` 类型增强，让
 * `ctx.tools` / `ctx.jobs` / `ctx.subprocess` / `ctx.attachments` / `ctx.llm`
 * 拿到精确类型。**仅类型导入，无运行时依赖**（所以不会把宿主包内联进 bundle）。
 *
 * 同时用声明合并给 jobs 注册本插件自己的作业种类（`transcribe`）：
 * 官方范本（`dsh-tool-pwsh`、`dsh-tool-workflow`）都是合并到**包根**
 * `'@deepseek-ai/dsh-jobs'`，而不是 `…/types` 子路径。
 */
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** 音频/视频转录（长任务，跑在后台作业里）。 */
    transcribe: 'transcribe'
    /** 链接下载（页面链接经 yt-dlp，直链经 ffmpeg）。 */
    download: 'download'
  }
}
