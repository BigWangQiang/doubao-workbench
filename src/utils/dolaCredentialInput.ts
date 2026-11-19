export interface DolaEmailCredentialInput {
  email: string;
  password: string;
}

export interface DolaCkImportInput {
  label: string;
  source: 'ck_json' | 'ck_txt';
  ckJson: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 将常见的多账号 Cookie 导出拆成独立 IPC 条目，避免把两个账号合并。 */
export function splitDolaCkJsonEntries(raw: unknown, fileLabel: string): DolaCkImportInput[] {
  if (Array.isArray(raw)) return [{ label: `${fileLabel} 1`, source: 'ck_json', ckJson: raw }];
  if (!isRecord(raw)) throw new Error('CK JSON 顶层格式无效');
  if (Array.isArray(raw.cookies)) return [{ label: `${fileLabel} 1`, source: 'ck_json', ckJson: raw }];
  const values = Object.values(raw);
  if (values.length === 0) throw new Error('CK JSON 未包含账号 Cookie');
  return values.map((value, index) => ({ label: `${fileLabel} ${index + 1}`, source: 'ck_json', ckJson: value }));
}

/** TXT 文件每个非空行是一套 Cookie Header，拆分后复用现有 CK 导入 IPC。 */
export function splitDolaCkTxtEntries(text: string, fileLabel: string): DolaCkImportInput[] {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('CK TXT 文件为空');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => ({ label: `${fileLabel} ${index + 1}`, source: 'ck_txt', ckJson: line }));
}

export function parseDolaEmailCredentialInput(text: string): DolaEmailCredentialInput[] {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('请输入账号----密码');
  const lines = text.split(/[\r\n,，;；]+/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    const separator = line.indexOf('----');
    if (separator <= 0 || separator + 4 >= line.length) {
      throw new Error(`第 ${index + 1} 行必须使用“账号----密码”格式`);
    }
    const email = line.slice(0, separator).trim();
    const password = line.slice(separator + 4).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`第 ${index + 1} 行邮箱格式无效`);
    if (!password) throw new Error(`第 ${index + 1} 行密码不能为空`);
    return { email, password };
  });
}
