import type { StoryboardInput } from '@doubao-studio/contracts';

const normalizedDigits = (text: string): string => text.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 65296));
export const imageName = (path: string): string => (path.split(/[\\/]/).pop() || path).replace(/\.[^.]+$/, '');
export const referenceName = (path: string, names: Record<string, string>): string => names[path] || imageName(path);
export const validReferenceName = (name: string): boolean => /^[\p{L}\p{N}_-]{1,60}$/u.test(name) && !/^图\d/.test(name);
export const storyboardImageLabel = (index: number): string => `图片${['一', '二', '三', '四', '五', '六', '七', '八', '九'][index] || index + 1}`;
const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 复用造梦 2.7.0 的独立行标题规则；正文中的分镜引用不会被切开。 */
export function splitStoryboards(text: string, duration: number): StoryboardInput[] {
  const normalized = normalizedDigits(text.replace(/\r\n?/g, '\n'));
  const headings = [...normalized.matchAll(/^[ \t]*(?:#{1,6}[ \t]*)?分镜[ \t]*(\d+)[ \t]*[:：]?[ \t]*$/gm)];
  if (!headings.length) throw new Error('没有找到分镜标题。请让“分镜001”“分镜002”各占一行。');
  if (normalized.slice(0, headings[0].index).trim()) throw new Error('首个分镜前还有正文，请将它移入对应分镜，避免遗漏。');
  if (headings.length > 100) throw new Error('单个批次最多 100 条分镜，请分批导入。');
  const numbers = new Set<string>();
  return headings.map((heading, index) => {
    const number = String(Number(heading[1])).padStart(3, '0');
    if (numbers.has(number)) throw new Error(`分镜${number}重复，请先调整编号。`);
    numbers.add(number);
    const body = normalized.slice(heading.index! + heading[0].length, headings[index + 1]?.index).trim();
    if (!body) throw new Error(`分镜${number}没有提示词。`);
    const seconds = body.match(/时长\s*[:：]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?/i)?.[1];
    return { id: crypto.randomUUID(), number, prompt: `分镜${number}\n${body}`, duration: seconds ? Number(seconds) : duration, images: [] };
  });
}

export function matchStoryboardImages(prompt: string, files: string[], names: Record<string, string> = {}): { images: string[]; errors: string[] } {
  const images: string[] = [];
  const errors: string[] = [];
  for (const match of prompt.matchAll(/@([^\s@，,。；;、：:！？!?（）()]+)/g)) {
    const name = match[1].replace(/^图\d+/, '');
    const matches = files.filter((file) => referenceName(file, names) === name);
    if (!matches.length) errors.push(`缺少参考图：${name}`);
    else if (matches.length > 1) errors.push(`参考图重名：${name}`);
    else if (!images.includes(matches[0])) images.push(matches[0]);
  }
  return { images, errors: [...new Set(errors)] };
}

export function storyboardPromptWithReferences(row: Pick<StoryboardInput, 'prompt' | 'images'>, names: Record<string, string> = {}): string {
  return row.prompt.replace(/@([^\s@，,。；;、：:！？!?（）()]+)/g, (token, raw: string) => {
    const name = raw.replace(/^图\d+/, '');
    const index = row.images.findIndex((file) => referenceName(file, names) === name);
    return index >= 0 ? `${name}：${storyboardImageLabel(index)}` : token;
  });
}

/** 长名字优先，已有 @ 保持一次；匹配结果同时用于附件绑定，避免只改文案。 */
export function smartMentionReferences(prompt: string, files: string[], names: Record<string, string>): { prompt: string; images: string[]; errors: string[] } {
  const known = [...new Set(files.map((file) => referenceName(file, names)))].filter(validReferenceName).sort((a, b) => b.length - a.length);
  if (!known.length) return { prompt, ...matchStoryboardImages(prompt, files, names) };
  const pattern = new RegExp(`@[^\\s@，,。；;、：:！？!?（）()]+|${known.map(escapePattern).join('|')}`, 'gu');
  const linked = prompt.replace(pattern, (token: string, offset: number): string => {
    if (token.startsWith('@')) return token;
    // 不拆开英文单词/编号，例如素材名 001 不匹配“分镜001”的标题。
    if (/^[A-Za-z0-9_-]/.test(token) && /[\p{L}\p{N}_-]/u.test(prompt[offset - 1] || '')) return token;
    if (/[A-Za-z0-9_-]$/.test(token) && /[A-Za-z0-9_-]/.test(prompt[offset + token.length] || '')) return token;
    return `@${token} `;
  });
  return { prompt: linked, ...matchStoryboardImages(linked, files, names) };
}

export function renameReferenceMentions(prompt: string, oldName: string, newName: string): string {
  return prompt.replace(/@([^\s@，,。；;、：:！？!?（）()]+)/g, (token: string, name: string): string => name === oldName ? `@${newName}` : token);
}
