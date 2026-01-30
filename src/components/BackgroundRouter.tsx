'use client';

import { usePathname } from 'next/navigation';
import React from 'react';

import { BackgroundCanvas } from './BackgroundCanvas';
import { BlurGradientCanvas } from './BlurGradientCanvas';

export function BackgroundRouter() {
  const pathname = usePathname();

  if (pathname === '/blur') return <BlurGradientCanvas />;
  if (pathname === '/dark') return <BackgroundCanvas baseColor="#000000" />;
  return <BackgroundCanvas />;
}
