export type AgentExecutionPhase = "analysis" | "choice" | "approval" | "execution" | "checking" | "summary";

export type AgentExecutionProgressDetails = {
    step: number;
    total: number;
    label: string;
    status: "running" | "waiting" | "complete";
};

const PROGRESS_BY_PHASE: Record<AgentExecutionPhase, AgentExecutionProgressDetails> = {
    analysis: { step: 1, total: 5, label: "分析用户要求", status: "running" },
    choice: { step: 2, total: 5, label: "等待选择生成参数", status: "waiting" },
    approval: { step: 2, total: 5, label: "等待批准执行", status: "waiting" },
    execution: { step: 3, total: 5, label: "执行画布操作 / 提交生成请求", status: "running" },
    checking: { step: 4, total: 5, label: "核对画布变更", status: "running" },
    summary: { step: 5, total: 5, label: "整理回复", status: "complete" },
};

export function getAgentExecutionProgressDetails(phase: AgentExecutionPhase): AgentExecutionProgressDetails {
    return PROGRESS_BY_PHASE[phase];
}
