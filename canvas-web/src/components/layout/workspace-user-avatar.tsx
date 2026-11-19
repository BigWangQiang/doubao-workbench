import { UserRound } from "lucide-react";
import { useEffect, useState } from "react";

import { IdentityProviderBadge } from "@/components/layout/identity-provider-badge";
import { resolveResourceUrl } from "@/services/api/resources";
import type { LocalUser } from "@/stores/use-user-store";
import type { MembershipTier, MembershipView } from "@/types/membership";

export const DEFAULT_USER_AVATAR_URL = "/avatars/lalor-default-avatar.png?v=20260922-1";
const MEMBERSHIP_FRAME_ASSET_VERSION = "20260912-1";

/**
 * Render an avatar after resolving private resource storage keys.
 * A resource key is not a browser URL; start with the placeholder so a
 * transient `onError` cannot permanently hide a valid asynchronously-resolved
 * avatar.
 */
export function ResolvedUserAvatar({
    src,
    alt = "",
    className,
    fallbackUrl = DEFAULT_USER_AVATAR_URL,
    membership,
}: {
    src?: string;
    alt?: string;
    className?: string;
    fallbackUrl?: string;
    membership?: MembershipView | null;
}) {
    const rawAvatarUrl = src?.trim() || fallbackUrl;
    const [avatarUrl, setAvatarUrl] = useState(() => rawAvatarUrl.startsWith("resource:") ? fallbackUrl : rawAvatarUrl);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let active = true;
        setFailed(false);
        if (!rawAvatarUrl.startsWith("resource:")) {
            setAvatarUrl(rawAvatarUrl);
            return () => { active = false; };
        }
        // Keep the safe placeholder while the authenticated resource URL is resolved.
        setAvatarUrl(fallbackUrl);
        void resolveResourceUrl(rawAvatarUrl, fallbackUrl).then((resolved) => {
            if (active) {
                setAvatarUrl(resolved || fallbackUrl);
                setFailed(false);
            }
        });
        return () => { active = false; };
    }, [fallbackUrl, rawAvatarUrl]);

    const frame = activeMembership(membership);
    const label = frame ? `${frame.tierLabel}会员头像` : undefined;
    const content = failed
        ? <span className="grid size-full place-items-center overflow-hidden rounded-full bg-muted text-foreground/55" aria-hidden="true"><UserRound className="size-1/2" /></span>
        : <img src={avatarUrl} alt={alt} referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailed(true)} />;
    if (!frame) return <span className={`resolved-user-avatar-plain ${className || ""}`}>{content}</span>;
    return (
        <span className={`membership-avatar-frame membership-tier-${frame.tier} ${className || ""}`} title={label} aria-label={label} role="img">
            <img className="membership-avatar-frame-art" src={membershipFrameURL(frame.tier)} alt="" aria-hidden="true" />
            <span className="membership-avatar-frame-content">{content}</span>
        </span>
    );
}

export function WorkspaceUserAvatar({ user, className, showProvider = true }: { user: LocalUser; className: string; showProvider?: boolean }) {
    const rawAvatarUrl = user.avatarUrl?.trim() || DEFAULT_USER_AVATAR_URL;
    const frame = activeMembership(user.membership);

    return (
        <span className={`workspace-user-avatar relative grid shrink-0 place-items-center ${className}`}>
            <span className={`grid size-full place-items-center ${frame ? "workspace-user-avatar-shell-frame" : "overflow-hidden rounded-full bg-muted text-foreground/55"}`}>
                <ResolvedUserAvatar src={rawAvatarUrl} membership={frame} className="size-full object-cover" />
            </span>
            {showProvider ? <IdentityProviderBadge user={user} compact className="absolute -bottom-1 -right-1" /> : null}
        </span>
    );
}

function activeMembership(membership?: MembershipView | null) {
    if (!membership?.active || !membership.expiresAt || new Date(membership.expiresAt).getTime() <= Date.now()) return null;
    return membership;
}

function membershipFrameURL(tier: MembershipTier) {
    return `/membership-frames/${tier}.svg?v=${MEMBERSHIP_FRAME_ASSET_VERSION}`;
}
