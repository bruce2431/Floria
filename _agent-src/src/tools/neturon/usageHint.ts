/**
 * usage hints — 检索/写入结果尾随的 JIT 使用提示
 * （原 engine/config.yaml usage_hint 段，随 TS 化迁为常量）
 */

export const USAGE_HINT_SEARCH = `检索结果按 cos+kw 加权排序。要点：
1. 只看列表的 blocks 摘录不够，用 neuron_source 工具取完整内容确认真实结果。
2. core_file 存可复用脚本/配置（按 path 读文件或直接取 content），不要重新造轮子。
3. 查询用自然语句（做了什么/怎么做的），不要关键词堆砌（BGE 对自然语句友好）。
4. 用户给了完整链接/ID 时，把 URL 或关键标识直接拼进查询，命中带相同 ID 的既有记录更准。
5. 结果与现实不符 → 用 remember(update) supersede 修正旧条目。`

export const USAGE_HINT_SOURCE = `按 core_file[].path 读脚本/配置复用；若 core_file 为空，直接按 blocks 内容描述手动操作。`

export const USAGE_HINT_PRECOG_ANNOTATE = `本次检索已写入 precog 记录（见 precog.record_id）。请顺手用 neuron_fill_precog 工具标注这条：
1. description ≥60 字：概括本次查询意图 + 检索命中情况。
2. accuracy_list 逐条对应 precog.results：true=结果直接回答了查询；revelant=相关但非直接答案；false=无关噪音。
刚用过这些结果，此刻标注最准；标注后的 precog 喂入认知聚合。`

export const USAGE_HINT_COGNITION_COLD = `本次检索命中的记忆尚未聚合出认知簇（cognition.nodes/communities 为空）。
用 neuron_fill_precog 标注本次 precog（record_id 见上）后，
这些记忆会在认知话题域聚合出节点/社群，下次检索即可反查溯源。`

/** remember 写入回执提示（回显通用录入约定；库个性文案经 config prompts.add_memory 注入） */
export const USAGE_HINT_REMEMBER = `录入约定：content 保留 [用户]/[Agent] 前缀对话格式，blocks 每条独立语义单元；可复用脚本放 core_file。纠错用 action=update（supersede，旧条目自动废弃不删除）。`
