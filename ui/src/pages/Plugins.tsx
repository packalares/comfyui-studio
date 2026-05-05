import { useMemo } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Package,
  Binary,
  List,
  History as HistoryIcon,
  Wrench,
  Boxes,
} from 'lucide-react';
import PageSubbar from '../components/layout/PageSubbar';
import { Card } from '../components/ui/card';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}

interface NavGroup {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: 'Plugins',
    icon: Package,
    items: [
      {
        to: '/plugins/installed',
        label: 'Installed',
        icon: List,
        description: 'Install and manage ComfyUI custom nodes',
      },
      {
        to: '/plugins/history',
        label: 'History',
        icon: HistoryIcon,
        description: 'Plugin install & uninstall operations log',
      },
    ],
  },
  {
    label: 'Python',
    icon: Binary,
    items: [
      {
        to: '/plugins/python/dependencies',
        label: 'Dependencies',
        icon: Wrench,
        description: 'Per-plugin requirements.txt status',
      },
      {
        to: '/plugins/python/packages',
        label: 'Packages',
        icon: Boxes,
        description: 'Installed pip packages',
      },
    ],
  },
];

const FLAT_ITEMS: NavItem[] = GROUPS.flatMap((g) => g.items);

/**
 * /plugins — sidebar layout hosting the nested plugin management routes.
 * The sidebar itself is just `NavLink`s grouped by Plugins / Python. The
 * CivitAI browser moved to the Models + Explore Source filter; legacy
 * /plugins/civitai/* URLs are handled by a redirect in `App.tsx`. The actual
 * content is rendered by the matched child route via `<Outlet />`.
 */
export default function Plugins() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const activeItem = useMemo(
    () =>
      FLAT_ITEMS.find((i) => pathname === i.to || pathname.startsWith(i.to + '/')) ||
      FLAT_ITEMS[0],
    [pathname],
  );

  return (
    <>
      <PageSubbar title="Plugins" description={activeItem.description} />
      <div className="page-container">
        <div className="flex flex-col md:flex-row gap-4">
          {/* Mobile: dropdown selector */}
          <div className="md:hidden">
            <label className="field-label mb-1 block">Section</label>
            <select
              value={activeItem.to}
              onChange={(e) => navigate(e.target.value)}
              className="w-full rounded-lg border bg-card px-3 py-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-brand"
            >
              {GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.items.map((item) => (
                    <option key={item.to} value={item.to}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Desktop sidebar */}
          <aside className="hidden md:block w-[220px] shrink-0">
            <Card asChild className="sticky top-28 p-2 space-y-3"><nav>
              {GROUPS.map((group) => {
                const GroupIcon = group.icon;
                return (
                  <div key={group.label} className="space-y-0.5">
                    <div className="flex items-center gap-1.5 px-2 pt-1 pb-1">
                      <GroupIcon className="w-3 h-3 text-muted-foreground" />
                      <span className="stat-label">
                        {group.label}
                      </span>
                    </div>
                    {group.items.map((item) => {
                      const ItemIcon = item.icon;
                      return (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          className={({ isActive }) =>
                            `flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors ${
                              isActive
                                ? 'bg-brand/10 text-brand'
                                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                            }`
                          }
                        >
                          <ItemIcon className="w-3.5 h-3.5" />
                          {item.label}
                        </NavLink>
                      );
                    })}
                  </div>
                );
              })}
            </nav></Card>
          </aside>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <Outlet />
          </div>
        </div>
      </div>
    </>
  );
}
