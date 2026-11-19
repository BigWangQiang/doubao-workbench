import { App } from 'antd';
import { useState } from 'react';
import { DeleteConfirmationDialog } from '@/components/ui/delete-confirmation';
import { useCanvasStore } from '@/stores/canvas/use-canvas-store';
import { useCanvasUiStore } from '@/stores/canvas/use-canvas-ui-store';
import { deleteCanvasProjectWithRemoteSync } from '@/services/user-data-sync';

export function CanvasDeleteProjectsDialog(): React.JSX.Element {
    const { message } = App.useApp();
    const ids = useCanvasUiStore((state) => state.deleteProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasUiStore((state) => state.removeSelectedProjectIds);
    const projects = useCanvasStore((state) => state.projects);
    const [deleting, setDeleting] = useState(false);
    const confirm = async (): Promise<void> => {
        if (!ids.length || deleting) return;
        setDeleting(true);
        const removed: string[] = [];
        try {
            for (const id of ids) {
                await deleteCanvasProjectWithRemoteSync(id);
                removed.push(id);
            }
            setDeleteIds([]);
            message.success(`已删除 ${removed.length} 个画布`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : '画布删除保存失败，请重试');
        } finally {
            removeSelectedIds(removed);
            setDeleting(false);
        }
    };
    return <DeleteConfirmationDialog title="删除画布" open={ids.length > 0} targetKey={ids.join(':')}
        targetLabel={ids.length === 1 ? projects.find((project) => project.id === ids[0])?.title || '所选画布' : `已选择的 ${ids.length} 个画布`}
        description="画布中的节点和绘图缓存会一并移除；素材库中独立保存的原始文件会保留。"
        loading={deleting} onCancel={() => { if (!deleting) setDeleteIds([]); }} onConfirm={confirm} />;
}
