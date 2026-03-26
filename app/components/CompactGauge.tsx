"use client"
import { useState, useEffect } from 'react'

interface GaugeProps {
  value: number
  max: number
  unit: string
  color: string
  label: string
}

export default function CompactGauge({ value, max, unit, color, label }: GaugeProps) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100))
  
  return (
    <div className="metric p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider font-semibold">{label}</span>
        <span className="text-lg font-mono font-bold" style={{ color }}>
          {value.toFixed(1)}<span className="text-xs ml-0.5">{unit}</span>
        </span>
      </div>
      <div className="w-full h-2 bg-[var(--metric-bg)] rounded-sm overflow-hidden border border-[var(--metric-border)]">
        <div 
          className="h-full rounded-sm transition-all duration-500 ease-out"
          style={{ 
            width: `${percentage}%`,
            backgroundColor: color,
            transition: 'width 0.5s ease-out'
          }}
        />
      </div>
    </div>
  )
}
