import { useEffect, useMemo, useState } from "react";
import { ChevronRight, LoaderCircle, Minus, Plus, Search, Sparkles, Users } from "lucide-react";
import { Button, Input, Modal } from "antd";
import { Link } from "react-router";

import { canvasThemes } from "@/lib/canvas-theme";
import { addSkill, listSkills, removeSkill, type Skill, type SkillCategory } from "@/services/api/skills";

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

type CanvasAgentSkillPickerProps = {
    disabled?: boolean;
    theme: CanvasTheme;
};

const PUBLIC_SKILL_PAGE_SIZE = 24;
const USER_SKILL_PAGE_SIZE = 80;

export function CanvasAgentSkillPicker({ disabled, theme }: CanvasAgentSkillPickerProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [debouncedQuery, setDebouncedQuery] = useState("");
    const [category, setCategory] = useState("all");
    const [page, setPage] = useState(1);
    const [publicSkills, setPublicSkills] = useState<Skill[]>([]);
    const [userSkills, setUserSkills] = useState<Skill[]>([]);
    const [categories, setCategories] = useState<SkillCategory[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [mutatingId, setMutatingId] = useState("");
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
        return () => window.clearTimeout(timer);
    }, [query]);

    useEffect(() => {
        if (disabled) setOpen(false);
    }, [disabled]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setLoadError("");
        const tag = category === "all" ? undefined : category;
        void Promise.all([
            listSkills({ page, page_size: PUBLIC_SKILL_PAGE_SIZE, scope: "public", sort: "popular", search: debouncedQuery || undefined, tag }),
            loadAllUserSkills(),
        ])
            .then(([publicResult, userSkillsResult]) => {
                if (cancelled) return;
                setPublicSkills((current) => page === 1 ? publicResult.skills : appendUniqueSkills(current, publicResult.skills));
                setUserSkills(userSkillsResult);
                setCategories(publicResult.categories);
                setHasMore(publicResult.has_more);
            })
            .catch((error) => {
                if (!cancelled) setLoadError(error instanceof Error ? error.message : "技能库加载失败，请稍后重试");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [category, debouncedQuery, open, page, reloadKey]);

    const skills = useMemo(() => {
        const byId = new Map<string, Skill>();
        userSkills.filter((skill) => skillMatchesFilter(skill, debouncedQuery, category)).forEach((skill) => byId.set(skill.skill_id, skill));
        publicSkills.forEach((skill) => byId.set(skill.skill_id, { ...byId.get(skill.skill_id), ...skill }));
        return Array.from(byId.values());
    }, [category, debouncedQuery, publicSkills, userSkills]);
    const addedCount = useMemo(() => userSkills.filter((skill) => skill.is_added || skill.is_owner).length, [userSkills]);

    const resetList = (nextCategory = category) => {
        setCategory(nextCategory);
        setPage(1);
        setPublicSkills([]);
    };

    const toggleSkill = async (skill: Skill) => {
        if (skill.is_owner) return;
        setMutatingId(skill.skill_id);
        setLoadError("");
        try {
            const result = skill.is_added ? await removeSkill(skill.skill_id) : await addSkill(skill.skill_id);
            setPublicSkills((items) => updateSkill(items, result.skill));
            setUserSkills((items) => skill.is_added
                ? items.filter((item) => item.skill_id !== skill.skill_id)
                : updateSkill(items, result.skill, true));
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "技能状态更新失败，请重试");
        } finally {
            setMutatingId("");
        }
    };

    return (
        <>
            <button
                type="button"
                className="canvas-agent-composer-tool relative"
                disabled={disabled}
                style={{
                    color: addedCount ? theme.accent.primary : theme.node.muted,
                    borderColor: addedCount ? theme.accent.primary : undefined,
                    background: addedCount ? theme.spatial.surface : undefined,
                }}
                aria-label={`技能商店，已加入 ${addedCount} 个技能`}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen(true)}
            >
                <Sparkles className="size-4" aria-hidden="true" />
                <span>引入技能</span>
                {addedCount ? (
                    <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full text-xs font-semibold" style={{ background: theme.accent.primary, color: theme.canvas.background }} aria-hidden="true">
                        {addedCount}
                    </span>
                ) : null}
            </button>

            <Modal
                open={open}
                onCancel={() => setOpen(false)}
                footer={null}
                width={1080}
                destroyOnHidden
                aria-labelledby="canvas-agent-skill-store-title"
                styles={{
                    container: { overflow: "hidden", border: "1px solid var(--border)", borderRadius: "var(--r-xl)", background: "var(--workspace-surface-strong)", color: "var(--foreground)" },
                    body: { padding: 0 },
                }}
            >
                <div className="flex min-w-0 flex-col" style={{ height: "min(72vh, 680px)" }} data-canvas-no-zoom data-canvas-wheel-scroll onWheelCapture={(event) => event.stopPropagation()}>
                    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4 md:px-6" style={{ borderColor: "var(--border)" }}>
                        <div className="flex min-w-0 items-center gap-3">
                            <span className="grid size-10 shrink-0 place-items-center rounded-xl" style={{ background: theme.spatial.surface, color: theme.accent.primary }}>
                                <Sparkles className="size-5" aria-hidden="true" />
                            </span>
                            <div className="min-w-0">
                                <h2 id="canvas-agent-skill-store-title" className="m-0 text-lg font-semibold" style={{ color: theme.node.text }}>技能商店</h2>
                                <p className="m-0 mt-1 text-xs" style={{ color: theme.node.muted }}>加入的技能会在智能体工作时按需匹配</p>
                            </div>
                        </div>
                        <span className="rounded-full px-3 py-2 text-sm font-medium" style={{ background: theme.spatial.surface, color: theme.node.text }} aria-live="polite">
                            已加入 <strong>{addedCount}</strong> 个技能
                        </span>
                    </header>

                    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[12rem_minmax(0,1fr)]">
                        <aside className="min-w-0 border-b p-3 md:overflow-y-auto md:border-b-0 md:border-r md:p-4" style={{ borderColor: "var(--border)" }} aria-label="技能分类">
                            <label className="mb-3 flex h-10 items-center gap-2 rounded-lg border px-3" style={{ borderColor: "var(--border)", background: "var(--workspace-surface)", color: theme.node.muted }}>
                                <Search className="size-4 shrink-0" aria-hidden="true" />
                                <Input
                                    aria-label="搜索技能"
                                    variant="borderless"
                                    value={query}
                                    placeholder="搜索技能"
                                    onChange={(event) => { setQuery(event.target.value); resetList(); }}
                                    className="min-w-0 p-0"
                                />
                            </label>
                            <div className="flex gap-1 overflow-x-auto md:grid md:overflow-visible" role="group" aria-label="按分类筛选技能">
                                <CategoryButton active={category === "all"} label="全部技能" count={skills.length} onClick={() => resetList("all")} />
                                {categories.map((item) => <CategoryButton key={item.value} active={category === item.value} label={item.label} onClick={() => resetList(item.value)} />)}
                            </div>
                        </aside>

                        <section className="thin-scrollbar min-h-0 overflow-y-auto p-4 md:p-6" aria-label="技能列表" aria-busy={loading}>
                            {loadError ? (
                                <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--status-danger)", color: theme.node.text }} role="alert">
                                    <span className="min-w-0">{loadError}</span>
                                    <Button size="small" onClick={() => setReloadKey((key) => key + 1)}>重试</Button>
                                </div>
                            ) : null}
                            {loading && !skills.length ? (
                                <div className="grid min-h-48 place-items-center" style={{ color: theme.node.muted }} role="status"><LoaderCircle className="size-5 animate-spin" aria-hidden="true" /><span className="sr-only">正在加载技能</span></div>
                            ) : skills.length ? (
                                <>
                                    <div className="mb-4 flex items-center justify-between gap-3">
                                        <h3 className="m-0 text-sm font-semibold" style={{ color: theme.node.text }}>{category === "all" ? "全部技能" : categories.find((item) => item.value === category)?.label}</h3>
                                        <span className="text-xs" style={{ color: theme.node.muted }}>{skills.length} 个</span>
                                    </div>
                                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                                        {skills.map((skill) => (
                                            <article key={skill.skill_id} className="flex min-h-48 min-w-0 flex-col rounded-lg border p-4 transition-colors" style={{ borderColor: "var(--border)", background: "var(--workspace-surface)", color: theme.node.text }}>
                                                <div className="mb-3 flex min-w-0 items-start justify-between gap-2">
                                                    <span className="min-w-0 truncate rounded px-2 py-1 text-xs" style={{ background: theme.spatial.surface, color: theme.node.muted }}>{categories.find((item) => item.value === skill.tag)?.label || "技能"}</span>
                                                    <span className="flex shrink-0 items-center gap-1 text-xs" style={{ color: theme.node.muted }}><Users className="size-3.5" aria-hidden="true" />{skill.added_count.toLocaleString()}</span>
                                                </div>
                                                <h4 className="m-0 line-clamp-2 text-sm font-semibold leading-5" title={skill.skill_name}>{skill.skill_name}</h4>
                                                <p className="mb-4 mt-2 line-clamp-4 flex-1 text-sm leading-6" style={{ color: theme.node.muted }}>{skill.description || "暂无技能简介"}</p>
                                                <div className="flex items-center justify-between gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
                                                    <span className="min-w-0 truncate text-xs" style={{ color: theme.node.muted }}>{skill.effective_user?.name || "技能作者"} · v{skill.version || "1.0.0"}</span>
                                                    <Button
                                                        size="small"
                                                        shape="round"
                                                        type={skill.is_added || skill.is_owner ? "default" : "primary"}
                                                        danger={skill.is_added && !skill.is_owner}
                                                        disabled={skill.is_owner || mutatingId === skill.skill_id}
                                                        loading={mutatingId === skill.skill_id}
                                                        icon={skill.is_added && !skill.is_owner ? <Minus className="size-3.5" aria-hidden="true" /> : skill.is_owner ? <Sparkles className="size-3.5" aria-hidden="true" /> : <Plus className="size-3.5" aria-hidden="true" />}
                                                        aria-label={skill.is_owner ? `${skill.skill_name}是自建技能` : skill.is_added ? `移除${skill.skill_name}` : `加入${skill.skill_name}`}
                                                        onClick={() => void toggleSkill(skill)}
                                                    >
                                                        {skill.is_owner ? "自建" : skill.is_added ? "移除" : "加入"}
                                                    </Button>
                                                </div>
                                            </article>
                                        ))}
                                    </div>
                                    {hasMore ? <div className="flex justify-center py-5"><Button loading={loading} onClick={() => setPage((current) => current + 1)}>加载更多</Button></div> : null}
                                    {loading && skills.length ? <div className="flex justify-center py-3" role="status"><LoaderCircle className="size-4 animate-spin" aria-label="正在加载更多技能" /></div> : null}
                                </>
                            ) : (
                                <div className="grid min-h-48 place-items-center text-center text-sm" style={{ color: theme.node.muted }}>
                                    <div><Sparkles className="mx-auto mb-3 size-6 opacity-50" aria-hidden="true" />{debouncedQuery ? "没有找到匹配的技能，试试更短的关键词。" : "这里还没有可用技能。"}</div>
                                </div>
                            )}
                        </section>
                    </div>

                    <footer className="flex shrink-0 justify-end border-t px-5 py-3 md:px-6" style={{ borderColor: "var(--border)" }}>
                        <Link className="flex min-h-10 items-center gap-2 text-sm font-medium" style={{ color: theme.accent.primary }} to="/skills" onClick={() => setOpen(false)}>
                            管理技能库 <ChevronRight className="size-4" aria-hidden="true" />
                        </Link>
                    </footer>
                </div>
            </Modal>
        </>
    );
}

function CategoryButton({ active, label, count, onClick }: { active: boolean; label: string; count?: number; onClick: () => void }) {
    return (
        <button
            type="button"
            className="flex min-h-10 shrink-0 items-center justify-between gap-3 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current md:w-full"
            style={{ background: active ? "var(--model-picker-hover-surface)" : "transparent", color: active ? "var(--foreground)" : "color-mix(in srgb, var(--foreground) 68%, transparent)" }}
            aria-pressed={active}
            onClick={onClick}
        >
            <span className="truncate">{label}</span>
            {count !== undefined ? <span className="text-xs tabular-nums">{count}</span> : null}
        </button>
    );
}

function appendUniqueSkills(current: Skill[], incoming: Skill[]) {
    const items = new Map(current.map((skill) => [skill.skill_id, skill]));
    incoming.forEach((skill) => items.set(skill.skill_id, skill));
    return Array.from(items.values());
}

function updateSkill(items: Skill[], skill: Skill, append = false) {
    const found = items.some((item) => item.skill_id === skill.skill_id);
    if (!found) return append ? [...items, skill] : items;
    return items.map((item) => item.skill_id === skill.skill_id ? { ...item, ...skill } : item);
}

function skillMatchesFilter(skill: Skill, query: string, category: string) {
    if (category !== "all" && skill.tag !== category) return false;
    if (!query) return true;
    const needle = query.toLocaleLowerCase();
    return [skill.skill_name, skill.description, skill.effective_user?.name].some((value) => String(value || "").toLocaleLowerCase().includes(needle));
}

async function loadAllUserSkills() {
    const skills: Skill[] = [];
    let page = 1;
    while (true) {
        const result = await listSkills({ page, page_size: USER_SKILL_PAGE_SIZE, scope: "mine", sort: "updated" });
        skills.push(...result.skills);
        if (!result.has_more) return skills;
        page += 1;
    }
}
