const READ_ONLY_CANVAS_TOOLS = new Set([
    "canvas_get_state",
    "canvas_get_selection",
    "canvas_export_snapshot",
    "canvas_offer_suggestions",
    "canvas_read_skill",
    "canvas_get_screenplay",
    "canvas_get_viral_video",
]);

const CANVAS_ACTION_VERB = /创建|新建|添加|删除|移除|连接|连线|移动|整理|排版|生成|修改|编辑|更新|缩放|放大|缩小|聚焦|选中|导入|写|改编|润色|上传|插入|复制|设置/;
const KNOWLEDGE_QUESTION = /怎么|如何|为什么|是什么|请问|教我|告诉我/;
const EXPLICIT_ACTION_REQUEST = /帮我|替我|给我|直接|马上|现在/;

export function isCanvasActionRequest(prompt: string) {
    const value = prompt.trim();
    if (!value || !CANVAS_ACTION_VERB.test(value)) return false;
    return !KNOWLEDGE_QUESTION.test(value) || EXPLICIT_ACTION_REQUEST.test(value);
}

export function shouldRequireCanvasToolCall(prompt: string, permissionMode: string, priorToolNames: readonly string[]) {
    if (permissionMode === "read-only" || !isCanvasActionRequest(prompt)) return false;
    return !priorToolNames.some((name) => !READ_ONLY_CANVAS_TOOLS.has(name));
}
