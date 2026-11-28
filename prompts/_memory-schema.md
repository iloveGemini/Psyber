---
version: 1
name: _memory-schema.md
slot: memory_shared
description: 记忆整理与深度反思共用的硬规范底座（[[短标题]]引用、标题唯一性、最小 Frontmatter、注册表 Schema 与跨阶段安全红线）
---
# 共享规范（标题、短链、Frontmatter 与通用红线）

- **站内引用统一用 `[[短标题]]`**，不用冗长相对路径或长标题：例如 `[[11-18 脚踝扭伤]]`、`[[11-18 反思·边界磨合]]`、`[[吉他练习进度]]`、`[[小橘]]`、`[[11-18 原话·留白约定]]`、`[[经验·熬夜提醒]]`；仅图片附件保留路径写法 `[照片](media/<hash>)`。
- **标题唯一性规范（短且全局唯一，≤ 12 字，严禁拼盘标题）**，日期严格以本轮 `<tidy_context>` / `<reflect_context>` 给出的日期（`YYYY-MM-DD`，月/日两位补零）为准：
  - 情景切片（`episodes/YYYY/MM/DD/ep-<slug>.md`）：`MM-DD 核心事件`
  - 反思卡片（`episodes/YYYY/MM/DD/rf-<slug>.md`）：`MM-DD 反思·主题`
  - 收藏原话（`favorite/YYYY-MM-DD-<slug>.md`）：`MM-DD 原话·主题`
  - 长期线索（`threads/<space>/<topic>.md`）：`分类·主题` 或短专名
  - 实体档案（`entities/<category>/<slug>.md`）：实体本名
  - 有条件经验（`lessons/<slug>.md`）：`经验·场景`
  - 高敏私密卡片（`sensitive/<slug>.md`）：`类别·主题`
  - 日/月/年梗概（`episodes/.../index.md`）：`YYYY-MM-DD 日梗概` / `YYYY-MM 月梗概` / `YYYY 年梗概`
- **卡片 Frontmatter 保持极薄**（仅用标准字段，不自造 `type` 字段）：
  - `title`: 遵循上方短且唯一的标题规范
  - `kind`: `episode` | `reflection` | `lesson` | `work` | `serial` | `note`（`index.md` 统一填 `note`）
  - `status`: `active` | `resolved` | `disputed` | `faded` | `archived`
    - `faded` 表示话题自然淡出、不再主动挂在召回里（仍可 `read` / `grep` 翻阅）；`archived` 表示主动完结或封存（若旧认识被新卡取代，设为 `archived` 并在正文写一句「已被 `[[新卡]]` 取代」）
  - `pinned`: 可选布尔（仅极少数值得长期保活、不被自动软淡出的情景切片 `ep-*.md` 填 `pinned: true`；被 `core/`、`favorite/` 或 `lessons/` 引用的切片会自动保活，无需手动标）
  - `created` / `updated`: `YYYY-MM-DD`
  - `covered_until`: 仅 `episodes/YYYY/MM/index.md`（`YYYY-MM-DD`）与 `episodes/YYYY/index.md`（`YYYY-MM`）必填，标明已滚动覆盖的截止位置
  - `when_to_recall`: 一句话触发提示（`lessons/` 与 `sensitive/` 必填，其余可选）
- **注册表最小 Schema 参考**：
  - `threads/REGISTRY.yaml`（`triggers` 优先 2–3 字口语短词；作品/连载类 `decay` 填 `none`）：
    ```yaml
    spaces:
      book-club:
        title: 共读书单
        triggers: [看书, 书单, 读后感]
        decay: none
        card_style: "每本书或独立清单单独一卡；进度类卡片顶部置顶最新状态"
    ```
  - `entities/REGISTRY.yaml`：
    ```yaml
    entities:
      xiaoju:
        name: 小橘
        aliases: [楼下橘猫]
        category: pets
        relation: 对方小区楼下经常喂的一只橘猫
        first_seen: 2026-11-12
    ```
- **跨阶段通用红线**：
  1. **不留明文凭证**：严禁在任何卡片里写入明文密码、API 密钥、Token、私钥、短信验证码、完整银行卡号或证件号（涉及配环境、换密钥或查账单时只记事件本身）。
  2. **高敏严格留白**：涉及亲密互动与习惯、个人创伤与脆弱经历、身心健康病史、敏感家庭或财务隐痛的内容单独立卡收进 `sensitive/`（推荐按 `health-*`、`trauma-*`、`intimacy-*`、`personal-*` 命名，必填 `when_to_recall`），普通 `episodes/` 切片与日/月/年 `index.md` 绝不复述私密细节（需要时间锚点时最多写一句克制留白，如“晚间聊了一些很私人的事”）。
  3. **核心画像局部修订**：修订 `core/self.md`、`core/user.md` 时始终用 `edit` 局部更新，绝不整篇覆写。
