export type ZiziConnectionState = 'ready' | 'starting' | 'expired' | 'unavailable';

export interface ZiziPluginStatus {
  appVersion: string;
  pluginVersion: string;
  connection: ZiziConnectionState;
  packageAvailable: boolean;
}

export interface ZiziPluginSaveResult {
  saved: boolean;
  filePath?: string;
  error?: string;
}

export interface ZiziPluginAPI {
  status: () => Promise<ZiziPluginStatus>;
  savePackage: () => Promise<ZiziPluginSaveResult>;
}
