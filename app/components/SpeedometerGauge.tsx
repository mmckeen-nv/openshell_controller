"use client"
import { useState, useEffect } from 'react'

interface GaugeProps {
  value: number
  max: number
  unit: string
  color: string
  label: string
  size?: 'small' | 'medium' | 'large'
}

export default function SpeedometerGauge({
  value,
  max,
  unit,
  color,
  label,
  size = 'medium'
}: GaugeProps) {
  const [percentage, setPercentage] = useState((value / max) * 100)
  const [animationValue, setAnimationValue] = useState(0)

  useEffect(() => {
    const target = (value / max) * 100
    setAnimationValue(target)
  }, [value, max])

  const sizeMap = {
    small: { width: 150, height: 100, strokeWidth: 8, fontSize: 24 },
    medium: { width: 200, height: 140, strokeWidth: 10, fontSize: 32 },
    large: { width: 300, height: 200, strokeWidth: 15, fontSize: 48 }
  }

  const s = sizeMap[size]

  // Calculate gauge angle (0-180 degrees)
  const startAngle = 0.75 * Math.PI
  const endAngle = 2.25 * Math.PI
  const currentAngle = startAngle + (endAngle - startAngle) * (animationValue / 100)

  const x1 = s.width / 2 + (s.width / 2 - 10) * Math.cos(startAngle)
  const y1 = s.height / 2 + (s.height / 2 - 10) * Math.sin(startAngle)
  const x2 = s.width / 2 + (s.width / 2 - 10) * Math.cos(currentAngle)
  const y2 = s.height / 2 + (s.height / 2 - 10) * Math.sin(currentAngle)

  return (
    <div className="flex flex-col items-center justify-center">
      <svg width={s.width} height={s.height} className="transform -rotate-90">
        {/* Background circle */}
        <circle
          cx={s.width / 2}
          cy={s.height / 2}
          r={s.width / 2 - 10}
          fill="none"
          stroke={color === '#76B900' ? 'rgba(118, 185, 0, 0.1)' : 'rgba(13, 71, 161, 0.1)'}
          strokeWidth={s.strokeWidth}
        />
        {/* Progress circle */}
        <circle
          cx={s.width / 2}
          cy={s.height / 2}
          r={s.width / 2 - 10}
          fill="none"
          stroke={color}
          strokeWidth={s.strokeWidth}
          strokeLinecap="round"
          strokeDasharray={2 * Math.PI * (s.width / 2 - 10)}
          strokeDashoffset={2 * Math.PI * (s.width / 2 - 10) * (1 - animationValue / 100)}
          style={{ transition: 'stroke-dashoffset 0.5s ease-out' }}
        />
      </svg>
      <div className="text-center mt-4">
        <div
          className={`font-bold`}
          style={{ color: color, fontSize: `${s.fontSize}px` }}
        >
          {value.toFixed(1)}
          <span className="text-sm" style={{ color: color }}>
            {unit}
          </span>
        </div>
        <div className="text-sm text-gray-600 dark:text-gray-400" style={{ color: color }}>
          {label}
        </div>
      </div>
    </div>
  )
}