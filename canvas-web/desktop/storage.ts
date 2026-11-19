import localforage from 'localforage';
import { desktopCall, isDesktop } from './bridge';

const preview = localforage.createInstance({ name: 'lalor-desktop-canvas-preview', storeName: 'state' });
export async function readLocal<T>(key: string): Promise<T | null> {
    return isDesktop ? desktopCall<T | null>('storage.get', { key }) : preview.getItem<T>(key);
}
export async function writeLocal(key: string, value: unknown): Promise<void> {
    if (isDesktop) await desktopCall('storage.set', { key, value });
    else await preview.setItem(key, value);
}
export async function removeLocal(key: string): Promise<void> {
    if (isDesktop) await desktopCall('storage.remove', { key });
    else await preview.removeItem(key);
}
