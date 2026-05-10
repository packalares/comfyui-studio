import { useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import PageSubbar from '../components/layout/PageSubbar';

interface NavItem {
  to: string;
  label: string;
  description: string;
}

// Kept as a flat list so the subbar description can change per sub-route.
// The actual navigation between these lives in the global app sidebar
// under the "Plugins" submenu — this page no longer owns its own aside.
const ITEMS: NavItem[] = [
  {
    to: '/plugins/installed',
    label: 'Installed',
    description: 'Install and manage ComfyUI custom nodes',
  },
  {
    to: '/plugins/history',
    label: 'History',
    description: 'Plugin install & uninstall operations log',
  },
  {
    to: '/plugins/python/dependencies',
    label: 'Dependencies',
    description: 'Per-plugin requirements.txt status',
  },
  {
    to: '/plugins/python/packages',
    label: 'Packages',
    description: 'Installed pip packages',
  },
];

/**
 * /plugins — page shell for the nested plugin management routes. The actual
 * content is rendered by the matched child route via `<Outlet />`. The
 * sub-route navigation lives in the global app sidebar (parent: Plugins,
 * children: Installed / History / Dependencies / Packages).
 */
export default function Plugins() {
  const { pathname } = useLocation();

  const activeItem = useMemo(
    () =>
      ITEMS.find((i) => pathname === i.to || pathname.startsWith(i.to + '/')) ||
      ITEMS[0],
    [pathname],
  );

  return (
    <>
      <PageSubbar title="Plugins" description={activeItem.description} />
      <div className="p-4">
        <Outlet />
      </div>
    </>
  );
}
