import { modelFamilyName, modelOptionName, modelVariantName, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";

type ModelFamily = {
    key: string;
    name: string;
    representative: string;
    models: string[];
    categorySortOrder: number;
    sortOrder: number;
};

function modelOrder(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    const entry = channel.modelCosts?.find((item) => item.model === modelOptionName(model));
    return {
        categoryId: entry?.categoryId || "",
        categorySortOrder: finiteOrder(entry?.categorySortOrder),
        sortOrder: finiteOrder(entry?.sortOrder),
    };
}

function finiteOrder(value: number | undefined) {
    return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function compareModelOrder(config: AiConfig, left: string, right: string) {
    const leftOrder = modelOrder(config, left);
    const rightOrder = modelOrder(config, right);
    return leftOrder.categorySortOrder - rightOrder.categorySortOrder
        || leftOrder.sortOrder - rightOrder.sortOrder
        || modelFamilyName(config, left).localeCompare(modelFamilyName(config, right), "zh-CN")
        || modelVariantName(config, left).localeCompare(modelVariantName(config, right), "zh-CN");
}

export function groupModelOptions(config: AiConfig, options: string[]): ModelFamily[] {
    const grouped = new Map<string, ModelFamily>();
    for (const model of options) {
        const name = modelFamilyName(config, model);
        const order = modelOrder(config, model);
        const key = `${order.categoryId || name}::${name}`;
        const existing = grouped.get(key);
        if (existing) {
            existing.models.push(model);
            existing.categorySortOrder = Math.min(existing.categorySortOrder, order.categorySortOrder);
            existing.sortOrder = Math.min(existing.sortOrder, order.sortOrder);
        } else {
            grouped.set(key, { key, name, representative: model, models: [model], categorySortOrder: order.categorySortOrder, sortOrder: order.sortOrder });
        }
    }
    // 后台分类排名控制分组位置；相同排名沿用型号优先级与名称，未配置分类的排在后面。
    return Array.from(grouped.values())
        .map((family) => ({ ...family, models: family.models.sort((left, right) => compareModelOrder(config, left, right)) }))
        .sort((left, right) => left.categorySortOrder - right.categorySortOrder
            || left.sortOrder - right.sortOrder
            || left.name.localeCompare(right.name, "zh-CN"));
}
