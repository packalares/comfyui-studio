import React from 'react';
import Navbar from './Navbar';
import RunningTaskCard from './RunningTaskCard';
import { Toaster } from './ui/sonner';

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main>{children}</main>
      <RunningTaskCard />
      <Toaster position="top-right" richColors />
    </div>
  );
}
