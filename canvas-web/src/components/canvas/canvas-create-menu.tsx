import { Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import "./canvas-command-menu.css";

export type CanvasCreateCommand = {
    id: string;
    label: string;
    icon: ReactNode;
    badge?: string;
    badgeTone?: "new";
    section: "node" | "project" | "resource";
    onClick: () => void;
};

export function CanvasCreateMenu({ commands, title = "添加节点", onClose }: { commands: CanvasCreateCommand[]; title?: string; onClose?: () => void }) {
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const searchButtonRef = useRef<HTMLButtonElement>(null);
    const search = query.trim().toLocaleLowerCase();
    const visibleCommands = commands.filter((command) => command.label.toLocaleLowerCase().includes(search));
    const nodeCommands = visibleCommands.filter((command) => command.section === "node");
    const resourceCommands = visibleCommands.filter((command) => command.section === "resource");

    useEffect(() => {
        if (searchOpen) inputRef.current?.focus();
    }, [searchOpen]);

    const closeSearch = () => {
        setQuery("");
        setSearchOpen(false);
        searchButtonRef.current?.focus();
    };

    return (
        <section className="canvas-create-menu" aria-label={title} data-canvas-no-zoom>
            <header className="canvas-command-header">
                {searchOpen ? (
                    <>
                        <Search className="canvas-command-search-icon" aria-hidden="true" />
                        <input
                            ref={inputRef}
                            className="canvas-command-search"
                            aria-label="搜索节点和资源"
                            placeholder="搜索节点和资源"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={(event) => {
                                event.stopPropagation();
                                if (event.key === "Escape") {
                                    event.preventDefault();
                                    closeSearch();
                                }
                            }}
                        />
                    </>
                ) : <h2 className="canvas-command-heading">{title}</h2>}
                <button
                    ref={searchButtonRef}
                    type="button"
                    className="canvas-command-search-toggle"
                    aria-label={searchOpen ? "关闭搜索" : "搜索节点和资源"}
                    aria-expanded={searchOpen}
                    onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}
                >
                    {searchOpen ? <X aria-hidden="true" /> : <Search aria-hidden="true" />}
                </button>
                {onClose ? <button type="button" className="canvas-command-search-toggle" aria-label={`关闭${title}菜单`} onClick={onClose}><X aria-hidden="true" /></button> : null}
            </header>

            <div className="canvas-command-list thin-scrollbar" data-canvas-wheel-scroll>
                <CanvasCreateCommandList commands={nodeCommands} />
                {resourceCommands.length > 0 ? (
                    <>
                        <h3 className="canvas-command-section">添加资源</h3>
                        <CanvasCreateCommandList commands={resourceCommands} />
                    </>
                ) : null}
                {visibleCommands.length === 0 ? <p className="canvas-command-empty" role="status">没有找到匹配的节点或资源</p> : null}
            </div>
        </section>
    );
}

function CanvasCreateCommandList({ commands }: { commands: CanvasCreateCommand[] }) {
    return (
        <div className="canvas-command-group">
            {commands.map((command) => (
                <button
                    key={command.id}
                    type="button"
                    className="canvas-command-row"
                    title={command.label}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={command.onClick}
                >
                    <span className="canvas-command-icon" aria-hidden="true">{command.icon}</span>
                    <span className="canvas-command-label">{command.label}</span>
                    {command.badge ? <span className="canvas-command-badge" data-tone={command.badgeTone}>{command.badge}</span> : null}
                </button>
            ))}
        </div>
    );
}
