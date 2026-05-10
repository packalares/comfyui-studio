import React from 'react';
import AppSidebar from './AppSidebar';
import TopBar from './TopBar';
import { SidebarProvider, SidebarInset } from '../ui/sidebar';
import { Toaster } from '../ui/sonner';
import ThemeSwitcher from './ThemeSwitcher';

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  return (
    // The body / outer wrapper scrolls naturally. TopBar and PageSubbar use
    // position:sticky so they pin at viewport top while the rest of the
    // page content (including the rounded inset's edges) scrolls past.
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="border border-border">
        <TopBar />
        {children}
      </SidebarInset>
      <Toaster position="top-center" />
      <ThemeSwitcher />
    </SidebarProvider>
  );
}
