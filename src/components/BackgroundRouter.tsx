'use client';

import { usePathname } from 'next/navigation';
import React from 'react';

import { BackgroundCanvas } from './BackgroundCanvas';

export function BackgroundRouter() {
  const pathname = usePathname();

  if (pathname === '/dark') return <BackgroundCanvas baseColor="#000000" />;
  return <BackgroundCanvas />;
}
