import { createPrevisScene } from "@/lib/canvas/previs/previs-scene";
import type { DirectorScene } from "@/types/director";
import type { PrevisScene } from "@/types/previs";

export function directorSceneToPrevisScene(scene: DirectorScene): PrevisScene {
    const defaults = createPrevisScene(scene.title || "未命名场景");
    const cameras = Array.isArray(scene.cameras) && scene.cameras.length ? scene.cameras : defaults.cameras;
    const shots = Array.isArray(scene.shots) && scene.shots.length
        ? scene.shots.map((shot) => ({ ...shot, aspectRatio: "9:16" as const }))
        : defaults.shots;
    const activeShotId = shots.some((shot) => shot.id === scene.activeShotId) ? scene.activeShotId : shots[0].id;

    return {
        ...defaults,
        ...scene,
        version: 1,
        title: scene.title || defaults.title,
        background: scene.background || defaults.background,
        environmentIntensity: Number.isFinite(scene.environmentIntensity) ? scene.environmentIntensity : defaults.environmentIntensity,
        environment: defaults.environment,
        gridVisible: scene.gridVisible !== false,
        objects: Array.isArray(scene.objects) ? scene.objects as unknown as PrevisScene["objects"] : defaults.objects,
        cameras: cameras as unknown as PrevisScene["cameras"],
        lights: Array.isArray(scene.lights) && scene.lights.length ? scene.lights as unknown as PrevisScene["lights"] : defaults.lights,
        shots: shots as unknown as PrevisScene["shots"],
        activeShotId,
        createdAt: scene.createdAt || defaults.createdAt,
        updatedAt: scene.updatedAt || defaults.updatedAt,
    };
}
