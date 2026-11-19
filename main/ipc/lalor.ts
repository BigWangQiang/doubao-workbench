import { ipcMain } from '../security/trustedIpc';
import type {
  LalorCatalog,
  LalorConnectionStatus,
  LalorOperationResult,
  LalorProfile,
  LalorPurchaseResult,
} from '@doubao-studio/contracts';
import { replaceIpcHandlers } from './lifecycle';
import {
  hasImportedDelivery,
  lalorAuth,
  markImportedDelivery,
} from '../auth/lalorAuth';
import { importAndCheckDolaCkText, importAndCheckDoubaoCkText } from './localManager';
import { normalizeDolaCkJsonEntries } from '../utils/dolaCkJson';

const LALOR_IPC_CHANNELS = [
  'lalor:status',
  'lalor:pair',
  'lalor:refresh',
  'lalor:profile',
  'lalor:catalog',
  'lalor:purchase',
  'lalor:logout',
] as const;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function success<T>(data: T): LalorOperationResult<T> {
  return { success: true, data };
}

function failure<T = undefined>(error: unknown, fallback: string): LalorOperationResult<T> {
  return { success: false, error: errorMessage(error, fallback) };
}

async function importPurchasedAccount(payload: Awaited<ReturnType<typeof lalorAuth.purchase>>): Promise<LalorPurchaseResult> {
  const delivery = payload.delivery;
  if (hasImportedDelivery(delivery.id)) {
    return {
      productId: delivery.productId,
      productName: delivery.productName,
      importedCount: 0,
      alreadyImported: true,
      profile: payload.profile,
    };
  }

  const productType = delivery.productType || 'dola_account';
  const contentType = delivery.contentType.toLowerCase().trim();
  let importedCount = 0;
  if (productType === 'doubao_account') {
    if (contentType !== 'json' && contentType !== 'txt') {
      throw new Error('购买成功但豆包 CK 交付格式无效，未导入本地账号池');
    }
    const entries = await importAndCheckDoubaoCkText(
      delivery.productName,
      undefined,
      delivery.content,
      undefined,
      contentType === 'txt' ? 'ck_txt' : 'ck_json',
    );
    importedCount = entries.length;
  } else {
    if (contentType !== 'json') throw new Error('购买成功但 Dola CK 交付格式无效，未导入本地账号池');
    let parsed: unknown;
    try {
      parsed = JSON.parse(delivery.content) as unknown;
    } catch {
      throw new Error('购买成功但 Dola CK JSON 无法解析，未导入本地账号池');
    }
    const entries = normalizeDolaCkJsonEntries(parsed);
    for (const [index, entry] of entries.entries()) {
      const label = entries.length === 1
        ? delivery.productName
        : `${delivery.productName} ${index + 1}`;
      // CK 内容只在主进程内解析并写入现有本地管理器，不返回给渲染层。
      await importAndCheckDolaCkText(label, undefined, JSON.stringify({ cookies: entry.cookies }), undefined, 'ck_json');
    }
    importedCount = entries.length;
  }
  markImportedDelivery(delivery.id);
  return {
    productId: delivery.productId,
    productName: delivery.productName,
    importedCount,
    alreadyImported: false,
    profile: payload.profile,
  };
}

export function registerLalorIPC(): () => void {
  const dispose = replaceIpcHandlers(ipcMain, LALOR_IPC_CHANNELS);

  ipcMain.handle('lalor:status', async (): Promise<LalorOperationResult<LalorConnectionStatus>> => {
    try {
      return success(await lalorAuth.status());
    } catch (error: unknown) {
      return failure(error, '读取 Lalor 连接状态失败');
    }
  });

  ipcMain.handle('lalor:pair', async (_event, code: string): Promise<LalorOperationResult<LalorConnectionStatus>> => {
    try {
      return success(await lalorAuth.pair(code));
    } catch (error: unknown) {
      return failure(error, 'Lalor 配对失败');
    }
  });

  ipcMain.handle('lalor:refresh', async (): Promise<LalorOperationResult<LalorConnectionStatus>> => {
    try {
      return success(await lalorAuth.refresh());
    } catch (error: unknown) {
      return failure(error, '刷新 Lalor 会话失败');
    }
  });

  ipcMain.handle('lalor:profile', async (): Promise<LalorOperationResult<LalorProfile>> => {
    try {
      return success(await lalorAuth.profile());
    } catch (error: unknown) {
      return failure(error, '读取 Lalor 会员资料失败');
    }
  });

  ipcMain.handle('lalor:catalog', async (): Promise<LalorOperationResult<LalorCatalog>> => {
    try {
      return success(await lalorAuth.catalog());
    } catch (error: unknown) {
      return failure(error, '读取 Dola 账号商品失败');
    }
  });

  ipcMain.handle('lalor:purchase', async (_event, params: { productId: string; idempotencyKey: string }): Promise<LalorOperationResult<LalorPurchaseResult>> => {
    try {
      const payload = await lalorAuth.purchase(params.productId, params.idempotencyKey);
      return success(await importPurchasedAccount(payload));
    } catch (error: unknown) {
      return failure(error, '购买 Dola 账号失败');
    }
  });

  ipcMain.handle('lalor:logout', async (): Promise<LalorOperationResult<{ serverRevoked: boolean }>> => {
    try {
      return success(await lalorAuth.logout());
    } catch (error: unknown) {
      return failure(error, '退出 Lalor 失败');
    }
  });

  return dispose;
}
