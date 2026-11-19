/** 工作台可选的 Lalor API 连接配置。API Key 永远不回传渲染进程。 */
export interface WorkbenchApiConfig {
  baseUrl: string;
  apiKeyConfigured: boolean;
}

export interface WorkbenchApiSaveInput {
  baseUrl: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface WorkbenchApiResult {
  success: boolean;
  config?: WorkbenchApiConfig;
  error?: string;
}
