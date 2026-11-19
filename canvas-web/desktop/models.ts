import { defaultConfig, useConfigStore, type AiConfig, type ModelChannel, type ModelCapability } from '@/stores/use-config-store';
import { defaultImageCapabilityConfig, defaultModelCapabilityConfig, type ModelCapabilityConfig } from '@/lib/model-capabilities';
import { desktopCall, isDesktop } from './bridge';

type CatalogModel = {
    modelKey: string; displayName: string; capability: ModelCapability; available: boolean; membershipLocked: boolean;
    capabilityConfig?: ModelCapabilityConfig; description: string; priceLabel: string; sortOrder: number;
    pricingMode: 'fixed_request' | 'per_second' | 'per_minute' | 'token'; displayPrice?: number;
};
type CatalogChannel = { id: string; displayName: string; name: string; models: CatalogModel[] };

function localChannel(platform: 'doubao' | 'dola'): ModelChannel {
    const models = platform === 'dola' ? ['image', 'chat', 'seedance-2.5'] : ['image', 'chat', 'seedance-2.5', 'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini'];
    return {
        id: 'desktop-' + platform, name: platform === 'doubao' ? '豆包账号池' : 'Dola 账号池', apiFormat: 'openai', apiKey: '', baseUrl: 'desktop://account-pool', scope: 'user', enabled: true, models,
        modelCosts: models.map((model, index) => {
            const capability = model === 'image' ? 'image' : model === 'chat' ? 'text' : 'video';
            const capabilityConfig: ModelCapabilityConfig = defaultModelCapabilityConfig('local-manager', model);
            if (capability === 'image') {
                capabilityConfig.image = defaultImageCapabilityConfig('openai-image');
                capabilityConfig.image.references.maskSupported = false;
                capabilityConfig.image.size = { parameter: 'none', values: ['auto'], default: 'auto', allowCustom: false };
                capabilityConfig.image.quality = { supported: false, values: ['auto'], default: 'auto' };
                capabilityConfig.image.transparentBackground = { supported: false, default: false };
            }
            if (capabilityConfig.video) {
                capabilityConfig.video.executionPlatform = platform;
                const supports15s = platform === 'doubao' && ['seedance-2.0', 'seedance-2.0-fast'].includes(model);
                capabilityConfig.video.duration = { selection: 'enum', values: model === 'seedance-2.5' ? [4, 5, 10, 30] : supports15s ? [5, 10, 15] : [5, 10], default: 10 };
                capabilityConfig.video.ratios = ['16:9', '9:16', '1:1'];
                capabilityConfig.video.defaultRatio = '16:9';
                capabilityConfig.video.resolutions = ['720p'];
                capabilityConfig.video.defaultResolution = '720p';
                capabilityConfig.video.references.maxVideos = 3;
                capabilityConfig.video.references.maxAudios = 3;
                capabilityConfig.video.operations = ['text_to_video', 'image_to_video', 'reference_to_video'];
            }
            const name = platform === 'doubao' ? '豆包账号池' : 'Dola 账号池';
            const displayName = model === 'image' ? '图片生成' : model === 'chat' ? '文本创作' : model.replace('seedance-', 'Seedance ');
            return { model, capability, displayName, familyName: name, variantName: displayName, categoryId: name, categorySortOrder: platform === 'doubao' ? 0 : 1, sortOrder: index, description: `使用${name}本地额度`, protocol: capability === 'video' ? 'local-manager' : capability === 'image' ? 'openai-image' : 'chat-completion', billingMode: 'fixed_request' as const, unitPriceMicrocredits: 0, capabilityConfig };
        }),
    };
}
export async function refreshModels(): Promise<void> {
    const channels = [localChannel('doubao'), localChannel('dola')];
    let modelError: unknown;
    let baseUrl = '';
    if (isDesktop) {
        const settings = await desktopCall<{ config: { apiKeyConfigured: boolean; baseUrl: string } }>('api.settings');
        baseUrl = settings.config.baseUrl;
        if (settings.config.apiKeyConfigured) {
            try {
                const catalog = await desktopCall<{ channels: CatalogChannel[] }>('models.list');
                for (const channel of catalog.channels) {
                    const usable = channel.models.filter((model) => model.available && !model.membershipLocked && model.capability !== 'audio');
                    const name = channel.displayName || channel.name;
                    channels.push({
                        id: 'yuyan-' + channel.id, name, apiFormat: 'openai', apiKey: '', hasApiKey: true,
                        baseUrl, scope: 'user', enabled: true, models: usable.map((model) => model.modelKey),
                        modelCosts: usable.map((model) => ({
                            model: model.modelKey, displayName: model.displayName || model.modelKey, capability: model.capability,
                            categoryId: name, categorySortOrder: 2, sortOrder: model.sortOrder,
                            description: model.priceLabel || model.description,
                            billingMode: model.pricingMode, unitPriceMicrocredits: model.displayPrice ?? 0,
                            protocol: model.capability === 'video' ? 'newapi-channel-2' : model.capability === 'image' ? 'openai-image' : 'chat-completion',
                            capabilityConfig: model.capabilityConfig,
                        })),
                    });
                }
            } catch (error) { modelError = error; }
        }
    }
    const current = useConfigStore.getState().config;
    const options = (capability: ModelCapability): string[] => channels.flatMap((channel) => (channel.modelCosts || []).filter((cost) => cost.capability === capability).map((cost) => `${channel.id}::${cost.model}`));
    const all = channels.flatMap((channel) => channel.models.map((model) => `${channel.id}::${model}`));
    const choose = (value: string, values: string[]): string => values.includes(value) ? value : values[0] || '';
    const config: AiConfig = { ...defaultConfig, ...current, channels, models: all, apiKey: '', baseUrl, model: choose(current.model, all), imageModels: options('image'), videoModels: options('video'), textModels: options('text'), audioModels: [], imageModel: choose(current.imageModel, options('image')), videoModel: choose(current.videoModel, options('video')), textModel: choose(current.textModel, options('text')), audioModel: '' };
    useConfigStore.getState().replaceConfig(config);
    if (modelError) throw modelError;
}
