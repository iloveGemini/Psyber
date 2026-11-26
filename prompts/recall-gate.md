---
version: 3
name: recall-gate
slot: decision
description: 每轮主对话召回门控、候选卡片精排及 1 跳双链扩展早停的系统分类器指令（含 true/false 双边判据，不送入 Psyber 人格上下文）
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

# evidence_sufficient
结合 `<resident_context>`、`<conversation>` 与首跳已选中的 `<selected_evidence>`，判断现有记忆信息是否已经足以自然且准确地接住最后一条 `user` 消息，无需再顺着双链展开更多关联卡片。

## true
`<selected_evidence>` 与 `<resident_context>` 已完整覆盖最后一条 `user` 消息回指的事件、人物、原话或线索进度，没有明显缺漏的关键背景，继续补充关联卡片只会增加冗余或喧宾夺主。

## false
`<selected_evidence>` 只给出了线索入口、概述或片段（例如提到了某张专卡、原话、故事或前因但缺少具体内容），或者还缺少回应最后一条 `user` 消息所需的关键细节，顺着双链再翻 1 跳有明显补全价值。

# hop_neighbor_relevance
结合 `<resident_context>`、`<conversation>` 与首跳已选中的 `<selected_evidence>`，判断经由双链找到的邻接卡片 `{{card_id}}`（来自 `<linked_neighbors>`）是否能补上 `<selected_evidence>` 中缺失的关键细节、原话、前因后果或长期线索，值得追加进本轮参考。

## true
邻接卡片 `{{card_id}}` 提供了 `<selected_evidence>` 与 `<resident_context>` 里没有的具体细节、逐字原话、故事/项目进展或直接相关的前因教训，能明显帮上最后一条 `user` 消息的回应。

## false
邻接卡片 `{{card_id}}` 的内容与 `<selected_evidence>` 重复、已被 `<resident_context>` 覆盖，或只是因为人物/主题泛泛相连而与当下这句对话无关，强行追加会显得扯远或翻旧账。
