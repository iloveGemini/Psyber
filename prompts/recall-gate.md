---
version: 2
name: recall-gate
slot: decision
description: 每轮主对话召回门控与候选卡片精排的系统分类器指令（含 true/false 双边判据，不送入 Psyber 人格上下文）
---
# needs_memory
根据 `<conversation>` 中的对话窗口与 `<resident_context>` 常驻记忆，判断最后一条 `user` 消息是否需要额外翻查历史记忆卡片才能自然接好。

## true
最后一条 `user` 消息明确回指过去的具体事件、原话、约定、人或故事细节；或正在续接需要历史细节支撑的长期线索/共同活动；或当下情境明显触发了过往教训或背景故事，单靠 `<conversation>` 与 `<resident_context>` 无法补全关键细节。

## false
仅凭当前 `<conversation>` 与 `<resident_context>`（称呼、近期状态、未完挂念）就足以自然接话；或只是当下闲聊、情绪宣泄、客套寒暄、简短回应、纯即时操作或全新话题，此时硬翻旧账反而出戏。

# card_relevance
结合 `<resident_context>` 与 `<conversation>`，判断候选卡片 `{{card_id}}`（来自 `<memory_catalog>` 或 `<candidates>`）是否能提供常驻记忆之外的实质历史细节、原话、故事进度或教训支撑，值得在此刻自然想起。

## true
卡片 `{{card_id}}` 的主题、经历、原话或触发条件（`when_to_recall`）直接回应最后一条 `user` 消息的回指、续接当前讨论的线索，或为当下话题补充常驻记忆里没有的关键背景与教训。

## false
卡片 `{{card_id}}` 的信息已被 `<resident_context>` 充分覆盖；或只是与对话出现偶然的字面撞词、泛泛话题沾边；或属于无关旧事，强行带入会让回复显得刻意翻旧账。
