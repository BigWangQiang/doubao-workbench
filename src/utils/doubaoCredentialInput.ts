export interface DoubaoCkImportInput {
  label: string;
  source: 'ck_json' | 'ck_txt';
  ckJson: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 将豆包常见的数组/对象键导出拆成独立 CK 条目。 */
export function splitDoubaoCkJsonEntries(raw: unknown, fileLabel: string): DoubaoCkImportInput[] {
  if (Array.isArray(raw)) return [{ label: `${fileLabel} 1`, source: 'ck_json', ckJson: raw }];
  if (!isRecord(raw)) throw new Error('豆包 CK JSON 顶层格式无效');
  if (Array.isArray(raw.cookies)) return [{ label: `${fileLabel} 1`, source: 'ck_json', ckJson: raw }];
  const values = Object.values(raw);
  if (values.length === 0) throw new Error('豆包 CK JSON 未包含账号 Cookie');
  return values.map((value, index) => ({ label: `${fileLabel} ${index + 1}`, source: 'ck_json', ckJson: value }));
}

/** TXT 先尝试完整 JSON；普通 TXT 则按每个非空行一套 Cookie Header 拆分。 */
export function splitDoubaoCkTxtEntries(text: string, fileLabel: string): DoubaoCkImportInput[] {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('豆包 CK TXT 文件为空');
  const normalized = text.replace(/^\uFEFF/, '').trim();
  if (/^[\[{]/.test(normalized)) {
    try {
      return splitDoubaoCkJsonEntries(JSON.parse(normalized) as unknown, fileLabel);
    } catch {
      throw new Error('豆包 CK TXT 中的 JSON 格式无效');
    }
  }
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => ({ label: `${fileLabel} ${index + 1}`, source: 'ck_txt', ckJson: line }));
}

