import { useEffect, useState, type ReactNode } from "react";
import { App, Alert, Button, Spin, Modal, Table } from "antd";
import { Link, useBlocker } from "react-router";
import { getTeamCanvas, leaseTeamCanvas, listTeamVersions, restoreTeamVersion, type TeamCanvasDetail, type TeamVersion } from "@/services/api/teams";
import { beginTeamCanvasSession, closeTeamCanvasSession, discardTeamCanvasSession, flushTeamCanvas, renewTeamCanvasSession, teamCanvasVersionCredentials } from "@/services/team-canvas-session";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { TeamCanvasPreview } from "./team-canvas-preview";
import "@/pages/teams/teams.css";

export function TeamCanvasSession({ id, children }: { id: string; children: ReactNode }) {
    const { message, modal } = App.useApp(); const userId = useUserStore((s) => s.user?.id);
    const [versions, setVersions] = useState<TeamVersion[] | null>(null); const [epoch, setEpoch] = useState(0);
    const [detail, setDetail] = useState<TeamCanvasDetail | null>(null); const [editing, setEditing] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
    const [readError, setReadError] = useState("");
    const blocker = useBlocker(editing);
    useEffect(() => {
        if (blocker.state !== "blocked") return;
        const dialog = modal.confirm({ title: "保存并离开团队画布？", content: "保存成功后交还编辑权；保存失败会留在当前页面。", okText: "保存并离开", cancelText: "继续编辑", onOk: async () => { try { await closeTeamCanvasSession(id); blocker.proceed(); } catch (e) { message.error((e as Error).message); throw e; } }, onCancel: () => blocker.reset() });
        return () => dialog.destroy();
    }, [blocker, id, modal, message]);
    useEffect(() => {
        let alive = true;
        const refresh = () => getTeamCanvas(id).then((v) => { if (alive) { setDetail(v); setReadError(""); } }).catch((e: unknown) => { if (alive) { setDetail(null); setReadError(e instanceof Error ? e.message : "读取团队画布失败"); } });
        if (!editing) void refresh();
        const timer = !editing ? window.setInterval(() => void refresh(), 8000) : undefined;
        return () => { alive = false; window.clearInterval(timer); };
    }, [id, editing, userId]);
    useEffect(() => {
        if (!editing) return;
        let alive = true;
        const timer = window.setInterval(() => {
            setSaving(true);
            void flushTeamCanvas(id).then(() => { if (alive) setError(""); }).catch((e: unknown) => { if (alive) setError((e as Error).message); }).finally(() => { if (alive) setSaving(false); });
        }, 5000);
        const heartbeat = window.setInterval(() => { void renewTeamCanvasSession(id).catch((e: unknown) => { if (alive) { setError((e as Error).message); setEditing(false); } }); }, 25000);
        const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", beforeUnload);
        return () => { alive = false; window.clearInterval(timer); window.clearInterval(heartbeat); window.removeEventListener("beforeunload", beforeUnload); };
    }, [editing, id]);
    useEffect(() => () => { void closeTeamCanvasSession(id).catch((e: unknown) => { discardTeamCanvasSession(id); message.error(`团队画布未保存，草稿留在本机：${(e as Error).message}`); }); }, [id, message]);
    const takeOver = async () => {
        setBusy(true);
        let token: string | undefined;
        try {
            const lease = await leaseTeamCanvas(id);
            token = lease.token;
            const latest = await getTeamCanvas(id);
            beginTeamCanvasSession(latest, lease.token, lease.lease.expiresAt);
            useCanvasStore.setState((s) => ({ projects: [...s.projects.filter((p) => p.id !== id), latest.project] }));
            setDetail(latest); setError(""); setEditing(true);
        } catch (e) { if (token) { try { await leaseTeamCanvas(id, token, true); } catch { message.warning("编辑权释放失败，将在租约到期后自动释放"); } } message.error((e as Error).message); } finally { setBusy(false); }
    };
    const requestTakeOver = () => {
        const local = useCanvasStore.getState().projects.find((p) => p.id === id);
        if (local && detail && JSON.stringify([local.nodes, local.connections, local.chatSessions]) !== JSON.stringify([detail.project.nodes, detail.project.connections, detail.project.chatSessions])) {
            modal.confirm({ title: "本机保留了不同的画布草稿", content: "接手会载入团队最新版本。建议先下载本机草稿，避免覆盖尚未保存的修改。", okText: "下载草稿并接手", cancelText: "暂不接手", onOk: async () => { exportDraft(); await takeOver(); } });
        } else void takeOver();
    };
    const release = async () => { setBusy(true); try { await closeTeamCanvasSession(id); setEditing(false); setDetail(await getTeamCanvas(id)); message.success("画布已保存，编辑权已交还"); } catch (e) { message.error((e as Error).message); } finally { setBusy(false); } };
    const exportDraft = () => { const project = useCanvasStore.getState().projects.find((p) => p.id === id); if (!project) return; const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = `${project.title}-本地草稿.json`; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); };
    const showVersions = async () => { try { setVersions(await listTeamVersions(id)); } catch (e) { message.error((e as Error).message); } };
    const restore = (version: TeamVersion) => modal.confirm({ title: `恢复到版本 ${version.revision}？`, content: "当前内容会先保存为历史版本。", onOk: async () => { await flushTeamCanvas(id); const session = teamCanvasVersionCredentials(id); const result = await restoreTeamVersion(id, version.id, session.revision, session.token); beginTeamCanvasSession(result, session.token, session.expiresAt); useCanvasStore.setState((s) => ({ projects: s.projects.map((p) => p.id === id ? result.project : p) })); setEpoch((v) => v + 1); setVersions(null); } });
    if (editing) return <><div key={epoch} className="h-full">{children}</div><div className="team-editbar" data-canvas-no-zoom data-canvas-wheel-scroll><span>{error ? `保存失败：${error}` : saving ? "正在保存…" : "团队画布 · 你正在编辑"}</span>{error && <Button size="small" onClick={exportDraft}>导出草稿</Button>}<Button size="small" onClick={() => void showVersions()}>历史版本</Button><Button size="small" loading={busy} onClick={() => void release()}>保存并交还</Button></div><Modal title="画布历史版本（最近 50 次保存）" open={!!versions} onCancel={() => setVersions(null)} footer={null}><Table rowKey="id" dataSource={versions || []} columns={[{ title: "版本", dataIndex: "revision" }, { title: "时间", dataIndex: "createdAt", render: (v) => new Date(v).toLocaleString() }, { title: "操作", render: (_, v: TeamVersion) => <Button onClick={() => restore(v)}>恢复</Button> }]} /></Modal></>;
    const occupied = detail?.lease && Date.parse(detail.lease.expiresAt) > Date.now();
    return <main className="team-viewer"><div className="team-heading"><div><Link to={detail?.project.teamId ? `/teams/${detail.project.teamId}` : "/teams"}>返回团队</Link><h1 className="text-xl my-3">{detail?.project.title || "团队画布"}</h1><p className="team-muted">{occupied ? "成员正在编辑，当前为只读预览" : "当前无人编辑，可接手继续创作"} · 生成使用团队积分</p></div>{detail?.canEdit && <Button type="primary" disabled={!!occupied} loading={busy} onClick={requestTakeOver}>接手编辑</Button>}</div>
        {error && <Alert type="error" showIcon title={error} description="已停止继续写入。未保存内容保留在本机缓存，请先导出草稿，再重新接手云端版本。" action={<Button onClick={exportDraft}>导出草稿</Button>} className="my-4" />}
        {readError && <Alert type="error" showIcon title={readError} description="暂时无法读取团队画布，恢复连接后将自动重试。" className="my-4" />}
        {!detail && !error && !readError && <Spin />}
        {detail && <TeamCanvasPreview project={detail.project} />}
    </main>;
}
