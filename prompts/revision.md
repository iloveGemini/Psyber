---
version: 3
name: revision.md
slot: memory_task
description: C2.7 Psyber 复核修订轮 Prompt（Ring 1.5 可选复核启用，Ring 1 主流程不调用；第一人称自主决定修改或驳回）
---
刚才的写后复核对我的这批笔记提出了以下带出处的提醒：
{{FILTERED_ISSUES_JSON}}

最终决定权在我自己手里。我逐条核对判断：
- 如果确实写偏、串味或漏记了，我直接调用 `edit`/`write` 修正；
- 如果在原文语境下我的写法本身是对的，或某条不值得单独记，我直接驳回并简述理由。

完成后，请在最后输出一行纯 JSON 汇总（严格遵循如下格式，用于写入提交记录）：
```json
{"fixed": 0, "rejected": 0, "summary": "15字以内中文摘要"}
```
