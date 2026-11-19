import React, { useLayoutEffect, useRef } from 'react';
import { Mentions } from 'antd';
import type { MentionsRef } from 'antd/es/mentions';
import { PictureOutlined } from '@ant-design/icons';

interface Props {
  value: string;
  label: string;
  names: string[];
  readOnly: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
}

/** 保留原生 textarea 的输入法、撤销和选区；镜像层只负责引用标签绘制。 */
export const StoryboardPromptInput: React.FC<Props> = ({ value, label, names, readOnly, onChange, onBlur }) => {
  const input = useRef<MentionsRef>(null);
  const host = useRef<HTMLDivElement>(null);
  const highlight = useRef<HTMLDivElement>(null);
  const sync = (): void => {
    const textarea = input.current?.textarea;
    if (!textarea || !host.current || !highlight.current) return;
    const bounds = textarea.getBoundingClientRect();
    const container = host.current.getBoundingClientRect();
    const style = window.getComputedStyle(textarea);
    Object.assign(highlight.current.style, {
      top: `${bounds.top - container.top}px`, left: `${bounds.left - container.left}px`,
      width: `${textarea.clientWidth}px`, height: `${textarea.clientHeight}px`,
      padding: style.padding, fontFamily: style.fontFamily, fontSize: style.fontSize,
      fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
      wordBreak: style.wordBreak, tabSize: style.tabSize, textAlign: style.textAlign,
    });
    highlight.current.scrollTop = textarea.scrollTop;
    highlight.current.scrollLeft = textarea.scrollLeft;
  };
  useLayoutEffect(() => {
    sync();
    const textarea = input.current?.textarea;
    const observer = new ResizeObserver(sync);
    if (textarea) observer.observe(textarea);
    if (host.current) observer.observe(host.current);
    return (): void => observer.disconnect();
  }, [value]);

  const chunks: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/@([^\s@，,。；;、：:！？!?（）()]+)/g)) {
    const offset = match.index!;
    chunks.push(value.slice(cursor, offset));
    chunks.push(names.includes(match[1]) ? <mark key={offset} className="storyboard-inline-mention">{match[0]}</mark> : match[0]);
    cursor = offset + match[0].length;
  }
  chunks.push(value.slice(cursor), '\n');

  return <div ref={host} className={`storyboard-rich-prompt ${value ? 'has-value' : ''}`}>
    <Mentions ref={input} aria-label={label} value={value} readOnly={readOnly}
      autoSize={{ minRows: 3, maxRows: 8 }} prefix="@" split=" "
      placeholder="输入提示词，输入 @ 选择参考图" notFoundContent="未找到参考图"
      popupClassName="storyboard-mentions-popup"
      options={names.map((name) => ({ value: name, label: <span className="storyboard-mention-option"><PictureOutlined />{name}</span> }))}
      onChange={onChange} onBlur={onBlur} onScroll={sync}
    />
    <div ref={highlight} className="storyboard-prompt-highlight" aria-hidden="true">{chunks}</div>
  </div>;
};
