import { leaseTeamCanvas, saveTeamCanvas, type TeamCanvasDetail } from "./api/teams";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";

type EditorSession = { userId: string; teamId: string; token: string; revision: number; expiresAt: number; savedAt: string; saving?: Promise<void>; error?: string };
const sessions = new Map<string, EditorSession>();
export function beginTeamCanvasSession(detail: TeamCanvasDetail, token: string, expiresAt: string) {
    const userId = useUserStore.getState().user?.id;
    if (!userId || !detail.project.teamId) throw new Error("团队登录状态无效");
    sessions.set(detail.project.id, { userId, teamId: detail.project.teamId, token, revision: detail.revision, expiresAt: Date.parse(expiresAt), savedAt: detail.project.updatedAt });
}
export function teamTaskCredentials(id?: string) {
    if (!id?.startsWith("tc_")) return {};
    const session = sessions.get(id);
    if (!session || session.userId !== useUserStore.getState().user?.id || session.expiresAt <= Date.now()) throw new Error("请先接手团队画布编辑权");
    return { teamId: session.teamId, teamLeaseToken: session.token };
}
export async function renewTeamCanvasSession(id: string) {
    const session = sessions.get(id);
    if (!session || session.userId !== useUserStore.getState().user?.id) throw new Error("团队会话已失效");
    const result = await leaseTeamCanvas(id, session.token);
    session.expiresAt = Date.parse(result.lease.expiresAt);
}
export async function flushTeamCanvas(id: string): Promise<void> {
    const session = sessions.get(id);
    teamTaskCredentials(id);
    if (!session) throw new Error("尚未获得编辑权");
    if (session.saving) { await session.saving; return flushTeamCanvas(id); }
    const project = useCanvasStore.getState().projects.find((p) => p.id === id);
    if (!project || project.updatedAt === session.savedAt) return;
    session.saving = (async () => {
        const { prepareRemoteCanvasProjects } = await import("./user-data-sync");
        const [prepared] = await prepareRemoteCanvasProjects([project], new Map());
        const result = await saveTeamCanvas(id, prepared, session.revision, session.token);
        session.revision = result.revision;
        session.savedAt = project.updatedAt;
        session.error = undefined;
        const current = useCanvasStore.getState().projects.find((p) => p.id === id);
        if (current === project) useCanvasStore.setState((state) => ({ projects: state.projects.map((p) => p.id === id ? { ...prepared, updatedAt: project.updatedAt } : p) }));
    })().catch((error: unknown) => { session.error = error instanceof Error ? error.message : "团队保存失败"; throw error; }).finally(() => { session.saving = undefined; });
    await session.saving;
}
export async function closeTeamCanvasSession(id: string) {
    const session = sessions.get(id);
    if (!session) return;
    await flushTeamCanvas(id);
    await leaseTeamCanvas(id, session.token, true);
    sessions.delete(id);
}
export function discardTeamCanvasSession(id: string) { sessions.delete(id); }
export function teamCanvasVersionCredentials(id: string) {
    teamTaskCredentials(id);
    const session = sessions.get(id)!;
    return { token: session.token, revision: session.revision, expiresAt: new Date(session.expiresAt).toISOString() };
}
