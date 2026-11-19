import { App } from "antd";
import { nanoid } from "nanoid";
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { blenderBridgeRequest, blenderChannelName, parseBlenderConnection, prepareBlenderCanvasNodes, readBlenderVideo, type BlenderConnection, type BlenderDelivery, type BlenderPairMessage } from "@/services/blender-bridge";
import { saveRemoteUserDataNow } from "@/services/user-data-sync";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

type Options = {
    projectId: string;
    projectLoaded: boolean;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    focusSelection: () => boolean;
};
type Receipt = { deliveryId: string; status: "ready" | "local" | "error" };

/** 只有正在编辑的画布接收配对；账号、路由或连接变化立即撤销旧接收器。 */
export function useCanvasBlenderBridge({ projectId, projectLoaded, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds, selectedNodeIdsRef, focusSelection }: Options) {
    const userId = useUserStore((state) => state.user?.id);
    const { message } = App.useApp();
    const focusRef = useRef(focusSelection);
    useEffect(() => { focusRef.current = focusSelection; }, [focusSelection]);

    useEffect(() => {
        if (!userId || !projectLoaded || !projectId || !window.BroadcastChannel) return;
        const channel = new BroadcastChannel(blenderChannelName(userId));
        const receiverId = nanoid();
        const messageKey = `blender:${receiverId}`;
        let active: AbortController | null = null;
        let connectionKey = "";
        let registered = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;

        const target = () => ({ receiverId, canvasId: projectId,
            title: (useCanvasStore.getState().projects.find((item) => item.id === projectId)?.title || "未命名画布").slice(0, 120) });
        const assertTarget = (controller: AbortController) => {
            if (closed || controller !== active || controller.signal.aborted || useUserStore.getState().user?.id !== userId
                || !useCanvasStore.getState().projects.some((item) => item.id === projectId)) {
                throw new Error("目标画布或登录账户已变化，请重新同步目标画布");
            }
        };

        const startReceiving = async (connection: BlenderConnection, requestId: string) => {
            active?.abort();
            clearTimeout(timer);
            const controller = new AbortController();
            active = controller;
            registered = false;
            let pendingReceipt: Receipt | null = null;
            let connectionErrorShown = false;
            const requestSignal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
            const sendReceipt = async (receipt: Receipt | { deliveryId: string; status: "receiving" }) => {
                await blenderBridgeRequest(connection, "receipt", requestSignal(), { body: { receiverId, ...receipt } });
            };
            try {
                assertTarget(controller);
                await blenderBridgeRequest(connection, "targets", requestSignal(), { body: target() });
                assertTarget(controller);
                registered = true;
                channel.postMessage({ type: "connected", requestId, target: target() } satisfies BlenderPairMessage);
                message.success("已连接 Blender，可在插件中选择此画布发送");
            } catch (cause) {
                if (controller.signal.aborted || closed) return;
                connectionKey = "";
                const detail = cause instanceof Error ? cause.message : "Blender 配对失败，请重新同步";
                channel.postMessage({ type: "error", requestId, message: detail } satisfies BlenderPairMessage);
                message.error(detail);
                return;
            }

            const poll = async () => {
                try {
                    assertTarget(controller);
                    if (pendingReceipt) {
                        await sendReceipt(pendingReceipt);
                        pendingReceipt = null;
                    }
                    const response = await blenderBridgeRequest(connection, "delivery", requestSignal(), { query: { receiverId } });
                    const data = await response.json() as { delivery?: BlenderDelivery | null };
                    connectionErrorShown = false;
                    if (!data.delivery) return;
                    const delivery = data.delivery;
                    if (delivery.canvasId !== projectId || !/^[a-f0-9]{32}$/.test(delivery.id) || !/^[a-f0-9]{32}$/.test(delivery.videoId)) {
                        throw new Error("白模发送目标不匹配，请重新同步目标画布");
                    }
                    await sendReceipt({ deliveryId: delivery.id, status: "receiving" });
                    try {
                        if (!nodesRef.current.some((node) => node.metadata?.blenderImportId === delivery.videoId)) {
                            const progress = (label: string, percent: number) => {
                                if (!controller.signal.aborted && !closed) message.open({ key: messageKey, type: "loading", content: `${label} ${percent}%`, duration: 0 });
                            };
                            const video = await readBlenderVideo(connection, receiverId, delivery,
                                AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]), (percent) => progress("正在接收白模", percent));
                            const additions = await prepareBlenderCanvasNodes(video, () => nodesRef.current,
                                () => assertTarget(controller), (percent) => progress("正在保存白模", percent));
                            assertTarget(controller);
                            // 在接收画布内增量更新，不能从同步标签页写入另一份陈旧画布状态。
                            const nodes = [...nodesRef.current, ...additions.nodes];
                            const connections = [...connectionsRef.current, ...additions.connections];
                            nodesRef.current = nodes;
                            connectionsRef.current = connections;
                            useCanvasStore.getState().updateProject(projectId, { nodes, connections });
                            setNodes(nodes);
                            setConnections(connections);
                            const selection = new Set(additions.nodes.map((node) => node.id));
                            selectedNodeIdsRef.current = selection;
                            setSelectedNodeIds(selection);
                            focusRef.current();
                        }
                        await flushCanvasStorePersistence();
                        assertTarget(controller);
                        try {
                            await saveRemoteUserDataNow();
                            assertTarget(controller);
                            pendingReceipt = { deliveryId: delivery.id, status: "ready" };
                            message.open({ key: messageKey, type: "success", content: "白模已加入当前画布，选择模型即可继续创作", duration: 5 });
                        } catch {
                            assertTarget(controller);
                            pendingReceipt = { deliveryId: delivery.id, status: "local" };
                            message.open({ key: messageKey, type: "warning", content: "白模已保存在本机画布，云同步暂未完成，请稍后保存", duration: 8 });
                        }
                    } catch (cause) {
                        if (controller.signal.aborted || closed) return;
                        pendingReceipt = { deliveryId: delivery.id, status: "error" };
                        message.open({ key: messageKey, type: "error", content: cause instanceof Error ? cause.message : "白模回传失败，请在 Blender 重新发送", duration: 8 });
                    }
                    if (pendingReceipt) {
                        await sendReceipt(pendingReceipt);
                        pendingReceipt = null;
                    }
                } catch (cause) {
                    if (!controller.signal.aborted && !closed && !connectionErrorShown) {
                        connectionErrorShown = true;
                        message.warning(cause instanceof Error ? cause.message : "Blender 连接中断，正在重新连接");
                    }
                } finally {
                    if (!controller.signal.aborted && !closed) timer = setTimeout(() => void poll(), 2000);
                }
            };
            void poll();
        };

        channel.onmessage = (event: MessageEvent<BlenderPairMessage>) => {
            const data = event.data;
            if (data?.type !== "connect" || typeof data.requestId !== "string" || !data.connection) return;
            const connection = parseBlenderConnection(new URLSearchParams({ port: String(data.connection.port), token: String(data.connection.token) }).toString());
            if (!connection) return;
            const key = `${connection.port}:${connection.token}`;
            if (key === connectionKey) {
                if (registered) channel.postMessage({ type: "connected", requestId: data.requestId, target: target() } satisfies BlenderPairMessage);
                return;
            }
            connectionKey = key;
            void startReceiving(connection, data.requestId);
        };
        return () => {
            closed = true;
            active?.abort();
            clearTimeout(timer);
            channel.close();
            message.destroy(messageKey);
        };
    }, [connectionsRef, message, nodesRef, projectId, projectLoaded, selectedNodeIdsRef, setConnections, setNodes, setSelectedNodeIds, userId]);
}
