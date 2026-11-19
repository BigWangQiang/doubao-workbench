import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob, resolveImageUrl } from "@/services/image-storage";
import { deleteRemoteAsset, deleteRemoteCanvasProject, getRemoteAsset, getRemoteCanvasProject, listRemoteAssets, listRemoteCanvasProjects, upsertRemoteAsset, upsertRemoteCanvasProject, type AssetDeletionResult, type RemoteUserDataSummary } from "@/services/api/user-data";
import { resourceFileUrl, resourceIdFromStorageKey, resourceIdFromUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import type { Asset } from "@/stores/use-asset-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { screenplayBusy } from "@/lib/canvas/canvas-screenplay";
import { removeCanvasNodes } from "@/lib/canvas/canvas-project-domain";

let activeRemoteUserId = "";
let applyingRemoteState = false;
let syncTimer: number | null = null;
let syncPromise: Promise<void> | null = null;
let syncQueued = false;
let subscriptionsInstalled = false;
let remoteAssetVersions = new Map<string, string>();
let remoteProjectVersions = new Map<string, string>();
let remoteProjectSnapshots = new Map<string, CanvasProject>();
const deletedCanvasTombstonePrefix = "infinite-canvas:deleted-projects:";
const deletingAssetKeys = new Set<string>();
let assetDeletionRevision = 0;

const LOCAL_STORAGE_KEY_PATTERN = /^(image|video|audio|file|video-reference|audio-reference):/;

export async function syncRemoteUserData(userId?: string | null) {
    activeRemoteUserId = userId || "";
    if (!activeRemoteUserId) return;
    const deletedCanvasIds = readDeletedCanvasTombstones(activeRemoteUserId);
    applyingRemoteState = true;
    try {
        const [remoteCanvas, remoteAssets] = await Promise.all([listRemoteCanvasProjects(), listRemoteAssets()]);
        // 删除操作可能与登录恢复/刷新同时发生。过滤持久化 tombstone，避免云端旧记录被重新合并到本地。
        const visibleRemoteCanvas = remoteCanvas.projects.filter((item) => !deletedCanvasIds.has(item.id));
        remoteProjectVersions = versionMap(visibleRemoteCanvas);
        remoteAssetVersions = versionMap(remoteAssets.assets);
        const localProjects = useCanvasStore.getState().projects.filter((item) => !deletedCanvasIds.has(item.id));
        const localAssets = useAssetStore.getState().assets;
        const [changedProjects, changedAssets] = await Promise.all([
            fetchNewerRemoteItems(localProjects, visibleRemoteCanvas, async (id) => (await getRemoteCanvasProject(id)).project),
            fetchNewerRemoteItems(localAssets, remoteAssets.assets, async (id) => (await getRemoteAsset(id)).asset),
        ]);
        // Merge by the original timestamps first. Normalizing a legacy payload
        // bumps its local timestamp so it can be persisted, and doing that
        // before this comparison could incorrectly make stale local data win.
        const mergedProjects = mergeById(localProjects, changedProjects).map((item) => recoverRemoteResourceReferences(item));
        const mergedAssets = mergeById(localAssets, await hydrateAssets(changedAssets)).map((item) => recoverRemoteResourceReferences(item));
        remoteProjectSnapshots = new Map();
        const remoteSummaryById = new Map(visibleRemoteCanvas.map((item) => [item.id, item]));
        [...changedProjects, ...mergedProjects].forEach((project) => {
            const summary = remoteSummaryById.get(project.id);
            if (summary && timeValue(summary.updatedAt) === timeValue(project.updatedAt)) {
                remoteProjectSnapshots.set(project.id, cloneCanvasProject(project));
            }
        });
        useCanvasStore.getState().replaceProjects(mergedProjects);
        useAssetStore.getState().replaceAssets(mergedAssets);
    } finally {
        applyingRemoteState = false;
    }
    // 首次登录可能带有尚未创建到云端的本地画布；先完成一次 upsert，避免详情页保存/分享先于项目创建。
    try {
        await saveRemoteUserDataNow();
    } catch (error) {
        console.warn("登录后画布首次同步失败，保留本地项目等待重试", error);
    }
    scheduleRemoteUserDataSync();
}

export function installRemoteUserDataAutoSync() {
    if (subscriptionsInstalled) return;
    subscriptionsInstalled = true;
    useCanvasStore.subscribe((state, previous) => {
        if (state.projects !== previous.projects) scheduleRemoteUserDataSync();
    });
    useAssetStore.subscribe((state, previous) => {
        if (state.assets !== previous.assets) scheduleRemoteUserDataSync();
    });
}

/** 只拉取素材增量；API 产物不依赖重新登录，也不触碰正在编辑的画布。 */
export async function refreshRemoteAssetLibrary() {
    const userId = activeRemoteUserId;
    if (!userId || useUserStore.getState().user?.id !== userId) return;
    if (syncPromise) await syncPromise;
    const deletionRevision = assetDeletionRevision;
    const { assets: summaries } = await listRemoteAssets();
    const local = useAssetStore.getState().assets;
    const fetched = await fetchNewerRemoteItems(local, summaries, async (id) => (await getRemoteAsset(id)).asset);
    const changed = await hydrateAssets(fetched);
    if (activeRemoteUserId !== userId || useUserStore.getState().user?.id !== userId || deletionRevision !== assetDeletionRevision) return;
    const visible = changed.filter((asset) => !deletingAssetKeys.has(`${userId}:${asset.id}`));
    for (const summary of summaries) {
        if (!deletingAssetKeys.has(`${userId}:${summary.id}`)) remoteAssetVersions.set(summary.id, summary.updatedAt);
    }
    useAssetStore.getState().replaceAssets(mergeById(useAssetStore.getState().assets, visible));
}

export function resetRemoteUserDataSync() {
    activeRemoteUserId = "";
    remoteAssetVersions.clear();
    remoteProjectVersions.clear();
    remoteProjectSnapshots.clear();
    if (syncTimer) {
        window.clearTimeout(syncTimer);
        syncTimer = null;
    }
}

/** Delete locally first for instant UI feedback, then confirm deletion in the remote store. */
export async function deleteCanvasProjectWithRemoteSync(id: string) {
    const projectId = id.trim();
    if (!projectId) return;
    const tombstones = activeRemoteUserId ? readDeletedCanvasTombstones(activeRemoteUserId) : new Set<string>();
    tombstones.add(projectId);
    if (activeRemoteUserId) writeDeletedCanvasTombstones(activeRemoteUserId, tombstones);
    useCanvasStore.getState().deleteProjects([projectId]);
    remoteProjectVersions.delete(projectId);
    remoteProjectSnapshots.delete(projectId);
    if (!activeRemoteUserId) return;
    // 等待正在进行的批量同步结束，避免旧快照的 upsert 排在删除请求之后再次复活项目。
    if (syncPromise) {
        syncQueued = true;
        try {
            await syncPromise;
        } catch {
            // 下面仍会执行显式删除；失败时保留 tombstone 供后续重试。
        }
    }
    try {
        await deleteRemoteCanvasProject(projectId);
        notifyStorageUpdated();
        tombstones.delete(projectId);
        writeDeletedCanvasTombstones(activeRemoteUserId, tombstones);
    } catch (error) {
        // Leave the tombstone in place; the next sync retries the remote delete without resurrection.
        scheduleRemoteUserDataSync();
        throw error;
    }
}

export function scheduleRemoteUserDataSync() {
    if (!activeRemoteUserId || applyingRemoteState) return;
    if (syncPromise) {
        syncQueued = true;
        return;
    }
    if (syncTimer) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
        syncTimer = null;
        void saveRemoteUserDataNow().catch((error) => console.warn("云端自动同步失败", error));
    }, 1200);
}

/**
 * Pull one canvas project while it is open. The summary request is cheap; the
 * full payload is fetched only after the server version changes. When the
 * browser has unsaved edits, a three-way merge keeps those edits while adding
 * remote nodes, connections, and newly created assistant sessions.
 */
export async function refreshRemoteCanvasProject(projectId: string) {
    if (projectId.startsWith("tc_")) return null;
    const id = projectId.trim();
    if (!activeRemoteUserId || !id || applyingRemoteState) return null;
    const { projects } = await listRemoteCanvasProjects();
    const summary = projects.find((item) => item.id === id);
    if (!summary) return null;
    const knownVersion = remoteProjectVersions.get(id);
    const changed = !knownVersion || versionsDiffer(summary.updatedAt, knownVersion);
    if (!changed) return null;

    const remote = (await getRemoteCanvasProject(id)).project;
    remoteProjectVersions.set(id, remote.updatedAt || summary.updatedAt);
    const local = useCanvasStore.getState().projects.find((item) => item.id === id);
    const localHasUnsyncedChanges = Boolean(local && versionsDiffer(local.updatedAt, knownVersion));
    const merged = local && localHasUnsyncedChanges
        ? mergeLiveCanvasProject(local, remote, remoteProjectSnapshots.get(id))
        : remote;
    remoteProjectSnapshots.set(id, cloneCanvasProject(remote));

    const nextProject = recoverRemoteResourceReferences(merged);
    // If local edits are pending, keeping an identical local payload means
    // the caller still owns the newer version and must upload it. Otherwise
    // refresh the store even when the content is equal so its timestamp tracks
    // the remote version and does not become falsely dirty on the next save.
    if (local && localHasUnsyncedChanges && canvasProjectContentEqual(local, nextProject)) return null;
    applyingRemoteState = true;
    try {
        const currentProjects = useCanvasStore.getState().projects;
        const nextProjects = local
            ? replaceById(currentProjects, [nextProject])
            : mergeById(currentProjects, [nextProject]);
        useCanvasStore.getState().replaceProjects(nextProjects);
    } finally {
        applyingRemoteState = false;
    }
    // A local+remote merge receives a new timestamp and must be persisted;
    // replacing the store above intentionally suppresses the subscription.
    if (nextProject.updatedAt !== remote.updatedAt) scheduleRemoteUserDataSync();
    return nextProject;
}

export async function createCanvasProjectWithRemoteSync(title: string, projectId?: string, initialContent?: Partial<Pick<CanvasProject, "nodes" | "connections">>) {
    const id = useCanvasStore.getState().createProject(title, projectId);
    if (initialContent) useCanvasStore.getState().updateProject(id, initialContent);
    if (!activeRemoteUserId) return { id, syncError: new Error("尚未建立云端同步会话") };
    try {
        await saveRemoteUserDataNow();
        return { id };
    } catch (syncError) {
        scheduleRemoteUserDataSync();
        return { id, syncError };
    }
}

export async function deleteAssetWithRemoteSync(id: string): Promise<AssetDeletionResult> {
    if (!id.trim()) throw new Error("缺少素材标识，无法删除");
    const userId = activeRemoteUserId;
    if (!userId && useUserStore.getState().user?.id) throw new Error("云端素材尚未同步完成，请稍后重试删除");
    const key = `${userId}:${id}`;
    if (deletingAssetKeys.has(key)) throw new Error("该素材正在删除，请稍候");
    const assertScope = () => {
        if (activeRemoteUserId !== userId || (userId && useUserStore.getState().user?.id !== userId)) {
            throw new Error("登录状态已变化，请刷新后重试删除");
        }
    };
    assertScope();
    deletingAssetKeys.add(key);
    assetDeletionRevision += 1;
    try {
        if (!userId) {
            useAssetStore.getState().removeAsset(id);
            return { id, releasedBytes: 0, retainedResourceCount: 0 };
        }
        // 阻止新批次保存此素材，并等已有上传/PUT 完成，避免 DELETE 后旧快照又写回。
        if (syncPromise) await syncPromise;
        assertScope();
        const asset = useAssetStore.getState().assets.find((item) => item.id === id);
        if (asset && versionsDiffer(remoteAssetVersions.get(id), asset.updatedAt)) {
            // 将最新资源引用交给服务端再删；否则刚上传但尚未同步的文件会变成孤儿。
            const [prepared] = await prepareRemoteAssets([asset], new Map());
            assertScope();
            const state = useAssetStore.getState();
            if (state.assets.find((item) => item.id === id) !== asset) throw new Error("素材已更新，请重新确认删除");
            // 删除失败时也保留已上传的稳定引用，重试不能再次上传同一份文件。
            state.replaceAssets(replaceById(state.assets, [prepared]));
            await upsertRemoteAsset(prepared);
            assertScope();
            remoteAssetVersions.set(id, prepared.updatedAt);
            if (useAssetStore.getState().assets.find((item) => item.id === id) !== prepared) throw new Error("素材已更新，请重新确认删除");
        }
        const result = await deleteRemoteAsset(id);
        assertScope();
        remoteAssetVersions.delete(id);
        useAssetStore.getState().removeAsset(id);
        notifyStorageUpdated();
        return result;
    } finally {
        deletingAssetKeys.delete(key);
    }
}

export async function deleteScreenplayWithRemoteSync(projectId: string, nodeId: string, expectedUserId: string, expectedRevision: number) {
    const assertScope = () => {
        if (!expectedUserId || activeRemoteUserId !== expectedUserId || useUserStore.getState().user?.id !== expectedUserId) {
            throw new Error("登录状态已变化，请刷新后重试删除");
        }
    };
    assertScope();
    if (!projectId.trim() || !nodeId.trim()) throw new Error("缺少剧本标识，无法删除");
    // 先同步旧快照，再读取最新节点，避免正在同步的内容覆盖本次删除。
    await saveRemoteUserDataNow();
    assertScope();
    const store = useCanvasStore.getState();
    const project = store.projects.find((item) => item.id === projectId);
    const node = project?.nodes.find((item) => item.id === nodeId);
    if (!project || !node?.metadata?.screenplay) throw new Error("剧本不存在或已被删除，请刷新列表");
    if (node.metadata.screenplay.document.revision !== expectedRevision) throw new Error("剧本内容已更新，请关闭弹窗并重新确认删除");
    if (screenplayBusy(node.metadata.screenplay)) throw new Error("剧本仍有进行中或待恢复的任务，请先处理任务再删除");
    if (node.metadata.batchChildIds?.length) throw new Error("该剧本包含分组子节点，请先在画布中解除分组再删除");
    const removed = removeCanvasNodes(project.nodes, new Set([nodeId]));
    const connections = project.connections.filter((item) => !removed.removedIds.has(item.fromNodeId) && !removed.removedIds.has(item.toNodeId));
    store.updateProject(projectId, { nodes: removed.nodes, connections });
    const updated = useCanvasStore.getState().projects.find((item) => item.id === projectId);
    try {
        await flushCanvasStorePersistence();
    } catch (error) {
        // 只恢复本次仍未被后续编辑替换的快照，不覆盖其他编辑。
        if (useUserStore.getState().user?.id === expectedUserId && useCanvasStore.getState().projects.find((item) => item.id === projectId) === updated) {
            useCanvasStore.getState().updateProject(projectId, { nodes: project.nodes, connections: project.connections });
        }
        throw error;
    }
    assertScope();
    let syncError: unknown;
    try { await saveRemoteUserDataNow(); }
    catch (error) { syncError = error; }
    assertScope();
    if (useCanvasStore.getState().projects.find((item) => item.id === projectId)?.nodes.some((item) => item.id === nodeId)) {
        throw new Error("云端剧本已发生变化，本次删除未完成，请刷新后重试");
    }
    return { syncError };
}

export async function saveRemoteUserDataNow() {
    if (!activeRemoteUserId) return;
    if (syncPromise) {
        syncQueued = true;
        return syncPromise;
    }
    syncPromise = drainRemoteUserDataChanges();
    try {
        await syncPromise;
    } finally {
        syncPromise = null;
    }
}

async function drainRemoteUserDataChanges() {
    do {
        syncQueued = false;
        await saveRemoteUserDataBatch();
    } while (syncQueued);
}

async function saveRemoteUserDataBatch() {
    try {
        const initialProjects = useCanvasStore.getState().projects;
        const currentAssets = useAssetStore.getState().assets;
        const initialDirtyProjects = initialProjects.filter((item) => !item.teamId && !item.id.startsWith("tc_") && versionsDiffer(remoteProjectVersions.get(item.id), item.updatedAt));
        // Re-read versions immediately before preparing a PUT. This prevents a
        // stale open tab from replacing nodes written by the online agent.
        await Promise.all(initialDirtyProjects.map((project) => refreshRemoteCanvasProject(project.id)));
        const currentProjects = useCanvasStore.getState().projects;
        const dirtyProjects = currentProjects.filter((item) => !item.teamId && !item.id.startsWith("tc_") && versionsDiffer(remoteProjectVersions.get(item.id), item.updatedAt));
        const dirtyAssets = currentAssets.filter((item) => !deletingAssetKeys.has(`${activeRemoteUserId}:${item.id}`) && versionsDiffer(remoteAssetVersions.get(item.id), item.updatedAt));
        const deletedProjectIds = new Set([...missingIds(remoteProjectVersions, currentProjects), ...readDeletedCanvasTombstones(activeRemoteUserId)]);
        const deletedAssetIds = missingIds(remoteAssetVersions, currentAssets).filter((id) => !deletingAssetKeys.has(`${activeRemoteUserId}:${id}`));
        if (!dirtyProjects.length && !dirtyAssets.length && !deletedProjectIds.size && !deletedAssetIds.length) return;
        const uploaded = new Map<string, string>();
        const projects = await prepareRemoteCanvasProjects(dirtyProjects, uploaded);
        const assets = await prepareRemoteAssets(dirtyAssets, uploaded);
        applyingRemoteState = true;
        if (projects.length) useCanvasStore.getState().replaceProjects(replaceById(currentProjects, projects));
        // 上传期间可能已有素材被显式删除；只更新当前仍在列表里的项，不能恢复旧列表。
        if (assets.length) useAssetStore.getState().replaceAssets(replaceById(useAssetStore.getState().assets, assets));
        applyingRemoteState = false;
        // SQLite 和接口频控都要求写入保持有界；逐项提交还能准确记录已完成版本。
        for (const project of projects) {
            await upsertRemoteCanvasProject(project);
            remoteProjectVersions.set(project.id, project.updatedAt);
            remoteProjectSnapshots.set(project.id, cloneCanvasProject(project));
        }
        for (const asset of assets) {
            if (deletingAssetKeys.has(`${activeRemoteUserId}:${asset.id}`)) continue;
            await upsertRemoteAsset(asset);
            remoteAssetVersions.set(asset.id, asset.updatedAt);
        }
        for (const id of deletedProjectIds) {
            await deleteRemoteCanvasProject(id);
            remoteProjectVersions.delete(id);
        }
        if (deletedProjectIds.size) notifyStorageUpdated();
        if (deletedProjectIds.size) {
            const tombstones = readDeletedCanvasTombstones(activeRemoteUserId);
            deletedProjectIds.forEach((id) => tombstones.delete(id));
            writeDeletedCanvasTombstones(activeRemoteUserId, tombstones);
        }
        for (const id of deletedAssetIds) {
            if (deletingAssetKeys.has(`${activeRemoteUserId}:${id}`)) continue;
            await deleteRemoteAsset(id);
            remoteAssetVersions.delete(id);
        }
        if (deletedAssetIds.length) notifyStorageUpdated();
    } finally {
        applyingRemoteState = false;
    }
}

function notifyStorageUpdated() {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("storage:updated"));
}

async function hydrateAssets(assets: Asset[]): Promise<Asset[]> {
    return Promise.all(
        assets.map(async (asset) => {
            if (asset.kind === "image" && asset.data.storageKey) {
                // 资源 ID 已包含可鉴权的文件入口，不需要为每张图片再请求一次
                // 元数据；直接交给浏览器加载，避免恢复素材时并发几十个请求。
                const resourceId = resourceIdFromStorageKey(asset.data.storageKey);
                const dataUrl = resourceId
                    ? resourceFileUrl(resourceId)
                    : await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl);
                return { ...asset, coverUrl: shouldReplaceEphemeralUrl(asset.coverUrl) ? dataUrl : asset.coverUrl, data: { ...asset.data, dataUrl } };
            }
            if (asset.kind === "video" && asset.data.storageKey) {
                const url = await resolveResourceOrMediaUrl(asset.data.storageKey, asset.data.url);
                return { ...asset, data: { ...asset.data, url } };
            }
            if (asset.kind === "audio" && asset.data.storageKey) {
                const url = await resolveResourceOrMediaUrl(asset.data.storageKey, asset.data.url);
                return { ...asset, data: { ...asset.data, url } };
            }
            if (asset.kind === "model" && asset.data.storageKey) {
                const url = await resolveResourceOrMediaUrl(asset.data.storageKey, asset.data.url);
                return { ...asset, data: { ...asset.data, url } };
            }
            return asset;
        }),
    );
}

async function prepareRemoteAssets(assets: Asset[], uploaded: Map<string, string>) {
    const result: Asset[] = [];
    for (const asset of assets) result.push(await ensureRemoteResourceReferences(asset, uploaded));
    return result;
}

export async function prepareRemoteCanvasProjects(projects: CanvasProject[], uploaded: Map<string, string>) {
    const result: CanvasProject[] = [];
    for (const project of projects) result.push(await ensureRemoteResourceReferences(project, uploaded));
    return result;
}

/**
 * Repair the old shape where a synced media payload retained its stable
 * `/api/resources/:id/file` URL but lost the companion `storageKey`.
 *
 * This pass is deliberately local-only: it never downloads, uploads, or
 * deletes a resource. The changed top-level record gets a fresh timestamp so
 * the normal debounced sync performs one bounded PUT and persists the repair.
 */
function recoverRemoteResourceReferences<T>(value: T): T {
    const recovered = recoverRemoteResourceValue(value);
    if (!recovered.changed || !recovered.value || typeof recovered.value !== "object" || Array.isArray(recovered.value)) {
        return recovered.value as T;
    }
    const record = recovered.value as Record<string, unknown>;
    if (typeof record.updatedAt !== "string" || !record.updatedAt) return recovered.value as T;
    return { ...record, updatedAt: new Date().toISOString() } as T;
}

function recoverRemoteResourceValue(value: unknown): { value: unknown; changed: boolean } {
    if (!value || typeof value !== "object") return { value, changed: false };
    if (Array.isArray(value)) {
        let changed = false;
        const result = value.map((item) => {
            const recovered = recoverRemoteResourceValue(item);
            changed ||= recovered.changed;
            return recovered.value;
        });
        return { value: changed ? result : value, changed };
    }

    const source = value as Record<string, unknown>;
    const next: Record<string, unknown> = { ...source };
    let changed = false;
    for (const [key, child] of Object.entries(source)) {
        const recovered = recoverRemoteResourceValue(child);
        next[key] = recovered.value;
        changed ||= recovered.changed;
    }

    const storageKey = typeof next.storageKey === "string" ? next.storageKey.trim() : "";
    if (!storageKey) {
        const resourceId = resourceIdFromResourceFields(next);
        if (resourceId) {
            next.storageKey = resourceStorageKey(resourceId);
            changed = true;
        }
    }
    return { value: changed ? next : value, changed };
}

async function ensureRemoteResourceReferences<T>(value: T, uploaded = new Map<string, string>()): Promise<T> {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        const result: unknown[] = [];
        for (const item of value) result.push(await ensureRemoteResourceReferences(item, uploaded));
        return result as T;
    }

    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        next[key] = await ensureRemoteResourceReferences(child, uploaded);
    }

    const storageKey = typeof next.storageKey === "string" ? next.storageKey : "";
    const remoteResourceId = resourceIdFromStorageKey(storageKey);
    if (remoteResourceId) return applyResourceReference(next, storageKey) as T;

    // Older generated assets already point at /api/resources/:id/file but lost
    // the companion storageKey. Recover the reference without downloading and
    // uploading the same object again.
    const urlResourceId = resourceIdFromResourceFields(next);
    if (urlResourceId) return applyResourceReference(next, resourceStorageKey(urlResourceId)) as T;

    if (!isLocalStorageKey(storageKey)) {
        const inline = inlineMediaDataUrl(next);
        if (!inline) return next as T;
        const resourceStorage = await uploadInlineDataUrl(inline).catch(() => "");
        return (resourceStorage ? applyResourceReference(next, resourceStorage) : next) as T;
    }

    const cached = uploaded.get(storageKey);
    const resourceStorage = cached || (await uploadLocalStorageKey(storageKey, next).catch(() => ""));
    if (!resourceStorage) return next as T;
    uploaded.set(storageKey, resourceStorage);
    return applyResourceReference(next, resourceStorage) as T;
}

function applyResourceReference(payload: Record<string, unknown>, storageKey: string) {
    const url = resourceFileUrl(storageKey.slice("resource:".length));
    payload.storageKey = storageKey;
    for (const key of ["content", "dataUrl", "url", "coverUrl"]) {
        if (typeof payload[key] === "string") payload[key] = url;
    }
    return payload;
}

function resourceIdFromResourceFields(payload: Record<string, unknown>) {
    // Prefer the primary media URL. A cover may intentionally point to a
    // separate image resource and must not replace the video's resource id.
    for (const key of ["url", "dataUrl", "content", "coverUrl"]) {
        const value = payload[key];
        const id = typeof value === "string" ? resourceIdFromUrl(value) : "";
        if (id) return id;
    }
    return "";
}

function inlineMediaDataUrl(payload: Record<string, unknown>) {
    for (const key of ["dataUrl", "content", "url", "coverUrl"]) {
        const value = payload[key];
        if (typeof value === "string" && /^data:(image|video|audio)\//i.test(value)) return value;
    }
    return "";
}

async function uploadInlineDataUrl(dataUrl: string) {
    const blob = await (await fetch(dataUrl)).blob();
    const kind: "image" | "video" | "audio" | "file" = blob.type.startsWith("image/") ? "image" : blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "file";
    const resource = await uploadResourceFile(blob, kind);
    return resourceStorageKey(resource.id);
}

async function uploadLocalStorageKey(storageKey: string, payload: Record<string, unknown>) {
    const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
    if (!blob) return "";
    const kind = blob.type.startsWith("image/") ? "image" : blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "file";
    const resource = await uploadResourceFile(blob, kind, {
        width: numberValue(payload.naturalWidth) || numberValue(payload.width),
        height: numberValue(payload.naturalHeight) || numberValue(payload.height),
        durationMs: numberValue(payload.durationMs),
    });
    return resourceStorageKey(resource.id);
}

function mergeById<T extends { id?: string; updatedAt?: string }>(local: T[], remote: T[]) {
    const items = new Map<string, T>();
    remote.forEach((item) => {
        if (item.id) items.set(item.id, item);
    });
    local.forEach((item) => {
        if (!item.id) return;
        const current = items.get(item.id);
        if (!current || timeValue(item.updatedAt) >= timeValue(current.updatedAt)) items.set(item.id, item);
    });
    return Array.from(items.values()).sort((a, b) => timeValue(b.updatedAt) - timeValue(a.updatedAt));
}

function mergeLiveCanvasProject(local: CanvasProject, remote: CanvasProject, baseline?: CanvasProject) {
    const nodes = mergeRemoteEntities(local.nodes, remote.nodes, baseline?.nodes);
    const connections = mergeRemoteEntities(local.connections, remote.connections, baseline?.connections);
    const chatSessions = mergeRemoteEntities(local.chatSessions, remote.chatSessions, baseline?.chatSessions);
    const localPrevisScenes = local.previsScenes || [];
    const previsScenes = mergeRemoteEntities(localPrevisScenes, remote.previsScenes || [], baseline?.previsScenes || []);
    const merged = { ...local, nodes, connections, chatSessions, previsScenes };
    if (nodes !== local.nodes || connections !== local.connections || chatSessions !== local.chatSessions || previsScenes !== localPrevisScenes) {
        merged.updatedAt = new Date().toISOString();
    }
    return merged;
}

function mergeRemoteEntities<T extends { id: string }>(local: T[], remote: T[], baseline?: T[]) {
    const baselineById = new Map((baseline || []).map((item) => [item.id, item]));
    const remoteById = new Map(remote.map((item) => [item.id, item]));
    const localIds = new Set(local.map((item) => item.id));
    let changed = false;
    const merged = local.map((item) => {
        const remoteItem = remoteById.get(item.id);
        const baselineItem = baselineById.get(item.id);
        if (remoteItem && baselineItem && valuesEqual(item, baselineItem) && !valuesEqual(remoteItem, baselineItem)) {
            changed = true;
            return remoteItem;
        }
        return item;
    });
    remote.forEach((item) => {
        if (!localIds.has(item.id)) {
            changed = true;
            merged.push(item);
        }
    });
    return changed ? merged : local;
}

function valuesEqual(left: unknown, right: unknown) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function canvasProjectContentEqual(left: CanvasProject, right: CanvasProject) {
    return valuesEqual({ ...left, updatedAt: "" }, { ...right, updatedAt: "" });
}

function cloneCanvasProject(project: CanvasProject) {
    return typeof structuredClone === "function" ? structuredClone(project) : JSON.parse(JSON.stringify(project)) as CanvasProject;
}

async function fetchNewerRemoteItems<T extends { id: string; updatedAt?: string }>(local: T[], remote: RemoteUserDataSummary[], fetchItem: (id: string) => Promise<T>) {
    const localById = new Map(local.map((item) => [item.id, item]));
    const pending = remote.filter((item) => {
        const current = localById.get(item.id);
        return !current || timeValue(item.updatedAt) > timeValue(current.updatedAt);
    });
    return Promise.all(pending.map((item) => fetchItem(item.id)));
}

function versionMap(items: RemoteUserDataSummary[]) {
    return new Map(items.map((item) => [item.id, item.updatedAt]));
}

function missingIds<T extends { id: string }>(remote: Map<string, string>, local: T[]) {
    const localIds = new Set(local.map((item) => item.id));
    return Array.from(remote.keys()).filter((id) => !localIds.has(id));
}

function replaceById<T extends { id: string }>(current: T[], changed: T[]) {
    const changedById = new Map(changed.map((item) => [item.id, item]));
    return current.map((item) => changedById.get(item.id) || item);
}

function timeValue(value?: string) {
    const time = value ? Date.parse(value) : 0;
    return Number.isFinite(time) ? time : 0;
}

function versionsDiffer(left?: string, right?: string) {
    if (left === right) return false;
    const leftTime = timeValue(left);
    const rightTime = timeValue(right);
    return leftTime === 0 || rightTime === 0 ? true : leftTime !== rightTime;
}

function isLocalStorageKey(value: string) {
    return LOCAL_STORAGE_KEY_PATTERN.test(value) && !resourceIdFromStorageKey(value);
}

function shouldReplaceEphemeralUrl(value: string) {
    return !value || value.startsWith("blob:") || value.startsWith("data:");
}

function readDeletedCanvasTombstones(userId: string) {
    if (typeof window === "undefined" || !userId) return new Set<string>();
    try {
        const value = JSON.parse(window.localStorage.getItem(deletedCanvasTombstonePrefix + userId) || "[]");
        return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : []);
    } catch {
        return new Set<string>();
    }
}

function writeDeletedCanvasTombstones(userId: string, values: Set<string>) {
    if (typeof window === "undefined" || !userId) return;
    try {
        if (values.size) window.localStorage.setItem(deletedCanvasTombstonePrefix + userId, JSON.stringify(Array.from(values)));
        else window.localStorage.removeItem(deletedCanvasTombstonePrefix + userId);
    } catch {
        // Storage can be unavailable in private browsing; the in-memory sync still prevents immediate resurrection.
    }
}

async function resolveResourceOrMediaUrl(storageKey: string, fallback: string) {
    const resourceId = resourceIdFromStorageKey(storageKey);
    if (resourceId) return resourceFileUrl(resourceId);
    const { resolveMediaUrl } = await import("@/services/file-storage");
    return resolveMediaUrl(storageKey, fallback);
}

function numberValue(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}
