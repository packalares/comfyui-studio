import { Fragment, useEffect, useState, type ComponentType } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Compass, Wand2, Image, Box, Package, Settings,
  MessageSquare, ChevronRight, Film,
} from 'lucide-react';
import {
  Sidebar, SidebarHeader, SidebarContent, SidebarFooter,
  SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuItem,
  SidebarMenuButton, SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton,
  useSidebar,
} from '../ui/sidebar';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '../ui/collapsible';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '../ui/popover';
import { cn } from '../../lib/utils';
import NavComfyControl from './NavComfyControl';
import RunningTaskCard from '../cards/RunningTaskCard';
import GpuStatusCard from '../cards/GpuStatusCard';

interface SubLink {
  to: string;
  label: string;
  /** Override the default exact-query active matcher — useful when a
   *  child represents a "mode" (e.g. Comfy in the Models page) that is
   *  active across multiple internal sub-states. */
  isActive?: (pathname: string, search: string) => boolean;
}
interface NavLinkItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  children?: SubLink[];
}

// Three groups, separated only by a dotted hairline (no eyebrow labels —
// the divider is enough). `label` is just the React key / a name for the
// section, never rendered.
const linkSections: { label: string; items: NavLinkItem[] }[] = [
  {
    label: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/templates', label: 'Templates', icon: Compass },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { to: '/studio', label: 'Studio', icon: Wand2 },
      { to: '/chat', label: 'Chat', icon: MessageSquare },
      { to: '/gallery', label: 'Gallery', icon: Image },
      {
        to: '/videoboard',
        label: 'Videoboard',
        icon: Film,
        children: [
          { to: '/videoboard', label: 'Projects' },
          { to: '/videoboard/characters', label: 'Characters' },
        ],
      },
    ],
  },
  {
    label: 'Manage',
    items: [
      {
        to: '/models',
        label: 'Models',
        icon: Box,
        // Children link to the same /models page with a source query — the
        // page already accepts `?source=ollama` (the legacy /chat/models
        // redirect confirms the contract). No new routes needed.
        children: [
          // Comfy template is the default Models view (Local catalog +
          // CivitAI). Active whenever we're on /models without an explicit
          // ollama source — internal source-dropdown switching between
          // Local and CivitAI shouldn't flip this submenu item off.
          {
            to: '/models',
            label: 'Comfy',
            isActive: (pathname, search) =>
              pathname === '/models'
              && new URLSearchParams(search).get('source') !== 'ollama',
          },
          { to: '/models?source=ollama', label: 'Ollama' },
        ],
      },
      {
        to: '/plugins',
        label: 'Plugins',
        icon: Package,
        // The Plugins page used to host its own internal aside menu — those
        // four sub-routes now live as direct sidebar children so users can
        // jump between them from anywhere in the app, and the page itself
        // is just the section content.
        children: [
          { to: '/plugins/installed', label: 'Installed' },
          { to: '/plugins/history', label: 'History' },
          { to: '/plugins/python/dependencies', label: 'Dependencies' },
          { to: '/plugins/python/packages', label: 'Packages' },
        ],
      },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

// Inactive row: full-strength label, leading icon dimmed so it reads as
// secondary until you're on it. Active row: a soft brand pill (tinted bg +
// brand label + brand icon) instead of shadcn's muted accent, and a taller
// h-9 row so the menu breathes. `[&>svg:first-child]` targets only the
// leading lucide icon so the colour shift skips the trailing chevron.
const ROW_POLISH =
  'h-9 transition-colors [&>svg:first-child]:text-sidebar-foreground/55 '
  + 'data-[active=true]:bg-brand/10 data-[active=true]:text-brand data-[active=true]:font-medium '
  + 'data-[active=true]:[&>svg:first-child]:text-brand '
  + 'data-[active=true]:hover:bg-brand/15 data-[active=true]:hover:text-brand';

export default function AppSidebar() {
  const { pathname } = useLocation();
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  // Auto-close the mobile sheet on every route change. Catches every
  // navigation path (NavLink, programmatic navigate, deep link) without
  // wiring an onClick on each individual link.
  useEffect(() => {
    if (isMobile && openMobile) setOpenMobile(false);
  // openMobile intentionally omitted: only fire on pathname change, not on
  // the open/close transition itself (which would loop).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, isMobile]);

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <NavLink to="/" className="flex items-center gap-2 px-2 h-10 font-semibold text-foreground">
          <Wand2 className="w-5 h-5 text-brand shrink-0" />
          <span className="group-data-[collapsible=icon]:hidden">ComfyUI Studio</span>
        </NavLink>
      </SidebarHeader>

      <SidebarContent className="gap-1">
        {linkSections.map((section, i) => (
          <Fragment key={section.label}>
            {/* Dashed, inset hairline between groups — short dashes, doesn't
                touch the rail edges. */}
            {i > 0 && (
              <div
                aria-hidden
                className="mx-3 border-t border-dashed border-sidebar-border/70 group-data-[collapsible=icon]:mx-2"
              />
            )}
            <SidebarGroup className="py-1">
              <SidebarGroupContent>
                <SidebarMenu>
                  {section.items.map((link) => (
                    <NavRow key={link.to} link={link} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </Fragment>
        ))}
      </SidebarContent>

      {/* Subtle top border so the GPU / running / control cards don't blend
          into the nav above. */}
      <SidebarFooter className="border-t border-sidebar-border/60">
        <GpuStatusCard />
        <RunningTaskCard />
        <NavComfyControl />
      </SidebarFooter>
    </Sidebar>
  );
}

// ---- Active-route helpers ----

function pathMatches(target: string, pathname: string, end?: boolean): boolean {
  const [base] = target.split('?');
  if (end) return pathname === base;
  return pathname === base || pathname.startsWith(base + '/');
}

function childMatches(child: SubLink, pathname: string, search: string): boolean {
  if (child.isActive) return child.isActive(pathname, search);
  const [base, query] = child.to.split('?');
  // Allow deeper sub-paths so e.g. `/plugins/installed/anything` still
  // highlights the Installed child. Exact-match was too strict and would
  // silently drop the highlight on any nested route.
  if (pathname !== base && !pathname.startsWith(base + '/')) return false;
  if (!query) {
    return new URLSearchParams(search).get('source') === null;
  }
  const want = new URLSearchParams(query);
  const have = new URLSearchParams(search);
  for (const [k, v] of want) {
    if (have.get(k) !== v) return false;
  }
  return true;
}

// ---- Per-row renderer ----

function NavRow({ link }: { link: NavLinkItem }) {
  const { pathname, search } = useLocation();
  const { state, isMobile } = useSidebar();
  const Icon = link.icon;
  const hasChildren = !!link.children?.length;
  const isCollapsedSidebar = !isMobile && state === 'collapsed';

  const parentActive = hasChildren
    ? link.children!.some((c) => childMatches(c, pathname, search))
    : pathMatches(link.to, pathname, link.end);

  if (!hasChildren) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          isActive={parentActive}
          tooltip={link.label}
          className={ROW_POLISH}
        >
          <NavLink to={link.to} end={link.end}>
            <Icon />
            <span>{link.label}</span>
          </NavLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  // Icon-only sidebar: parent is a Popover trigger that lists the children
  // (the inline Collapsible can't render — SidebarMenuSub auto-hides under
  // `group-data-[collapsible=icon]`).
  if (isCollapsedSidebar) {
    return (
      <SidebarMenuItem>
        <Popover>
          <PopoverTrigger asChild>
            <SidebarMenuButton
              isActive={parentActive}
              tooltip={link.label}
              className={ROW_POLISH}
            >
              <Icon />
              <span>{link.label}</span>
            </SidebarMenuButton>
          </PopoverTrigger>
          <PopoverContent side="right" align="start" sideOffset={8} className="w-44 p-1">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {link.label}
            </div>
            {link.children!.map((c) => {
              const active = childMatches(c, pathname, search);
              return (
                <NavLink
                  key={c.to}
                  to={c.to}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors',
                    active
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                      : 'text-foreground hover:bg-muted',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'h-1.5 w-1.5 rounded-full transition-colors',
                      active ? 'bg-brand' : 'bg-muted-foreground/40',
                    )}
                  />
                  <span>{c.label}</span>
                </NavLink>
              );
            })}
          </PopoverContent>
        </Popover>
      </SidebarMenuItem>
    );
  }

  return <CollapsibleNavRow link={link} parentActive={parentActive} />;
}

function CollapsibleNavRow({
  link,
  parentActive,
}: {
  link: NavLinkItem;
  parentActive: boolean;
}) {
  const { pathname, search } = useLocation();
  const Icon = link.icon;
  // Auto-open when navigation lands on a child route, but never auto-close
  // — once a user has manually collapsed the group, navigating elsewhere
  // shouldn't pop it back open.
  const [open, setOpen] = useState(parentActive);
  useEffect(() => {
    if (parentActive) setOpen(true);
  }, [parentActive]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarMenuItem className="group/collapsible">
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            isActive={parentActive}
            tooltip={link.label}
            className={ROW_POLISH}
          >
            <Icon />
            <span>{link.label}</span>
            <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-[collapsible-up_180ms_ease-out] data-[state=open]:animate-[collapsible-down_180ms_ease-out]">
          {/* border-s-0 kills SidebarMenuSub's built-in spine — we draw the
              whole tree (spine + curved branches) with the per-item ::before
              below, so the line never overhangs past the last child. */}
          <SidebarMenuSub className="border-s-0">
            {link.children!.map((c) => {
              const active = childMatches(c, pathname, search);
              return (
                <SidebarMenuSubItem
                  key={c.to}
                  // ::before is an L (left + bottom border, rounded inner
                  // corner): its vertical part reaches up to the previous
                  // item's centre so consecutive Ls chain into one spine, and
                  // the rounded bottom-left curves into this row. Drawn on the
                  // <li> (not the button, which has overflow-hidden). `first:`
                  // caps the spine at the top so it doesn't poke into the
                  // parent row. Brand-coloured when active.
                  className={cn(
                    "before:absolute before:-left-[11px] before:-top-[18px] before:bottom-1/2 before:w-[18px] before:rounded-bl-lg before:border-b before:border-l before:border-muted-foreground/40 before:content-[''] first:before:top-0",
                    active && 'before:border-brand',
                  )}
                >
                  <SidebarMenuSubButton
                    asChild
                    isActive={active}
                    className={cn(
                      'transition-colors data-[active=true]:bg-transparent data-[active=true]:hover:bg-transparent data-[active=true]:text-brand data-[active=true]:font-medium',
                    )}
                  >
                    <NavLink to={c.to}>
                      <span>{c.label}</span>
                    </NavLink>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}
