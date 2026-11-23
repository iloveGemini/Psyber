---
version: 4
name: review.md
slot: memory_task
description: C2.7 写后独立复核轮 Prompt（Ring 1.5 可选非阻塞复核启用，Ring 1 主流程不调用；只读视角）
---
你正在执行本次记忆整理的「写后独立复核」。你只有只读视角，不改任何文件，只负责对照「原始对话段」检查「本轮新建或修改的记忆卡片」是否存在失真或漏记。

# 核查范围（重要）

- **新建卡片（标记为 `NEW`）**：核查卡片全部正文。
- **修改既有卡片（标记为 `MODIFIED`）**：**只核查本轮新增或修改的片段（diff `+` 行）**；卡片中原有历史内容仅作为只读上下文提供，**绝不得**对原有历史内容报 `attribution` 或 `no_bleed` 问题。
- **本轮未写/改任何卡片**：只检查「漏记（omission）」一项。

# 复核清单

1. 归属（attribution）：本轮新写/修改的每句事实、引用与细节，是否都能在原始对话段里找到依据？有没有凭空编造的台词或细节？
2. 不串味（no_bleed）：本轮新写/修改的内容里，有没有把别的日子、别的活动或无关话题混进这张卡？
3. 漏记（omission）：原始对话段里明确出现的具体承诺、偏好、决定、状态变更或重要事件，有没有哪件完全没落进任何一张卡？

# 规则与输出格式

- 按问题类别提供准确出处（拿不出准确出处的怀疑直接放弃，不要硬挑刺）：
  - 若为 `attribution` 或 `no_bleed`：`cardPath` 必填为本次写/改卡片路径；`cardQuote` 必填为**该卡片本轮新增/修改片段中的逐字原句**；`transcriptQuote` 可选（仅当原文里有逐字对照句子时填写，无对照原句时请省略或留空，严禁填入“原文未提及”等说明文字）。
  - 若为 `omission`：`transcriptQuote` 必填为**原始对话段中的逐字片段**；`cardPath` 可填建议落卡路径或 `null`（若本轮未写任何卡）。
- 严格只输出如下 JSON，不要输出任何额外解释：

```json
{
  "issues": [
    {
      "cardPath": "episodes/2026/11/19/ep-example.md",
      "category": "attribution | no_bleed | omission",
      "cardQuote": "attribution/no_bleed 时必填：卡片本轮新增/修改片段中的逐字原句",
      "transcriptQuote": "omission 时必填（其他类型可选）：原始对话段中的逐字片段",
      "detail": "一句话说明具体问题"
    }
  ]
}
```

若没有发现实质问题，输出 `{"issues": []}`。
