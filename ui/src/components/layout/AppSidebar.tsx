import { useEffect, useState, type ComponentType } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Compass, Wand2, Image, Box, Package, Settings,
  MessageSquare, ChevronRight,
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

// Three invisible sections — separated by a thin divider, no loud eyebrow
// labels. Reads as "information architecture" without taking pixels for
// section headers.
const linkSections: NavLinkItem[][] = [
  [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/explore', label: 'Explore', icon: Compass },
  ],
  [
    { to: '/studio', label: 'Studio', icon: Wand2 },
    { to: '/chat', label: 'Chat', icon: MessageSquare },
    { to: '/gallery', label: 'Gallery', icon: Image },
  ],
  [
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
];

// Active row: brand-coloured icon + slightly heavier label + the default
// accent background that ships with shadcn's sidebar. Inactive: smooth
// transition into bg-muted on hover. The `[&>svg]` selector targets the
// lucide icon child so the colour shift only hits the leading icon, not
// the trailing chevron.
const ROW_POLISH =
  'transition-colors data-[active=true]:font-medium data-[active=true]:[&>svg:first-child]:text-brand';

export default function AppSidebar() {
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <NavLink to="/" className="flex items-center gap-2 px-2 h-10 font-semibold text-foreground">
          <Wand2 className="w-5 h-5 text-brand shrink-0" />
          <span className="group-data-[collapsible=icon]:hidden">ComfyUI Studio</span>
        </NavLink>
      </SidebarHeader>

      <SidebarContent>
        {linkSections.map((section, i) => (
          <SidebarGroup
            key={i}
            // Hairline divider between sections (skip first). Stays out of
            // the way in icon-only mode where the rows are already small.
            className={i > 0 ? 'mt-1 border-t border-sidebar-border/60 pt-1' : ''}
          >
            <SidebarGroupContent>
              <SidebarMenu>
                {section.map((link) => (
                  <NavRow key={link.to} link={link} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
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
          <SidebarMenuSub>
            {link.children!.map((c) => {
              const active = childMatches(c, pathname, search);
              return (
                <SidebarMenuSubItem key={c.to}>
                  <SidebarMenuSubButton
                    asChild
                    isActive={active}
                    // Active child gets a brand dot + heavier weight as the
                    // affordance — drop the default accent background since
                    // the dot already reads cleanly against the indent
                    // guideline and the bg makes the row feel "selected"
                    // even when nothing else is.
                    className={cn(
                      'transition-colors data-[active=true]:bg-transparent',
                      active && 'font-medium',
                    )}
                  >
                    <NavLink to={c.to}>
                      <span
                        aria-hidden
                        className={cn(
                          'h-1.5 w-1.5 rounded-full shrink-0 transition-colors',
                          active ? 'bg-brand' : 'bg-muted-foreground/40',
                        )}
                      />
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
