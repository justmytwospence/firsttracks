import type { Aspect } from "@/pathfinder/index.d.ts";
import { aspectStore } from '@/store';
import { type ActiveElement, ArcElement, type ChartEvent, Chart as ChartJS, Legend, RadialLinearScale, Tooltip } from 'chart.js';
import type { FeatureCollection } from 'geojson';
import { useState } from 'react';
import { useMemo } from 'react';
import { PolarArea } from 'react-chartjs-2';

ChartJS.register(RadialLinearScale, ArcElement, Tooltip, Legend);

export interface AspectChartProps {
  aspectPoints: FeatureCollection;
  excludedAspects?: Aspect[];
  onAspectClick?: (aspect: Aspect) => void;
}

export function AspectChart({ aspectPoints, excludedAspects, onAspectClick }: AspectChartProps) {
  const { setHoveredAspect } = aspectStore();
  const [isAspectLocked, setIsAspectLocked] = useState(false);
  const aspects = aspectPoints.features.map(feature => feature.properties?.aspect);
  
  const chartData = useMemo(() => {
    const aspectCounts = aspects.reduce((acc, aspect) => {
      if (aspect) {
        acc[aspect] = (acc[aspect] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);

    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const aspectMap = {
      N: 'North',
      NE: 'Northeast',
      E: 'East',
      SE: 'Southeast',
      S: 'South',
      SW: 'Southwest',
      W: 'West',
      NW: 'Northwest'
    };

    const counts = directions.map(dir => aspectCounts[aspectMap[dir as keyof typeof aspectMap]] || 0);
    const total = counts.reduce((sum, count) => sum + count, 0);

    return {
      labels: directions,
      datasets: [{
        data: counts,
        backgroundColor: [
          'rgba(255, 99, 132, 0.7)',
          'rgba(54, 162, 235, 0.7)',
          'rgba(255, 206, 86, 0.7)',
          'rgba(75, 192, 192, 0.7)',
          'rgba(153, 102, 255, 0.7)',
          'rgba(255, 159, 64, 0.7)',
          'rgba(201, 203, 207, 0.7)',
          'rgba(75, 192, 192, 0.7)'
        ],
        borderWidth: 1
      }]
    };
  }, [aspects]);

  const options = {
    responsive: true,
    scales: {
      r: {
        type: 'radialLinear' as const,
        startAngle: -22.5,
        ticks: {
          display: true,
          callback: function(tickValue: number | string, index: number, ticks: any[]) {
            const chart = (this as any).chart;
            const total = chart.data.datasets[0].data.reduce((a: number, b: number) => a + b, 0);
            return `${Math.round((Number(tickValue) / total) * 100)}%`;
          },
          backdropColor: 'transparent'  // Makes the background transparent
        },
        beginAtZero: true
      }
    },
    plugins: {
      tooltip: {
        callbacks: {
          label: (context: any) => {
            const total = context.chart.data.datasets[0].data.reduce((a: number, b: number) => a + b, 0);
            const value = context.raw;
            const percentage = ((value / total) * 100).toFixed(1);
            return `${percentage}%`;
          }
        }
      },
      legend: {
        display: false
      }
    },
    onHover: (event: ChartEvent, elements: ActiveElement[], chart: ChartJS) => {
      if (!event?.native || !chart?.chartArea) {
        if (!isAspectLocked) setHoveredAspect(null);
        return;
      }
      
      // Set cursor to pointer when hovering over chart elements
      chart.canvas.style.cursor = elements.length ? 'pointer' : 'default';
      
      if (isAspectLocked) return;
      
      if (elements?.[0]) {
        const index = elements[0].index;
        const direction = chartData.labels[index];
        const aspectMap: Record<string, string> = {
          'N': 'North',
          'NE': 'Northeast',
          'E': 'East',
          'SE': 'Southeast',
          'S': 'South',
          'SW': 'Southwest',
          'W': 'West',
          'NW': 'Northwest'
        };
        const hoveredAspect = aspectMap[direction] as Aspect;
        setHoveredAspect(hoveredAspect);
      } else {
        setHoveredAspect(null);
      }
    },
    onClick: (_event: ChartEvent, elements: ActiveElement[]) => {
      if (elements?.[0]) {
        const index = elements[0].index;
        const direction = chartData.labels[index];
        const aspectMap: Record<string, Aspect> = {
          'N': 'North',
          'NE': 'Northeast',
          'E': 'East',
          'SE': 'Southeast',
          'S': 'South',
          'SW': 'Southwest',
          'W': 'West',
          'NW': 'Northwest'
        };
        const clickedAspectDisplay = aspectMap[direction];
        // Convert to lowercase for the excluded aspects list (matches WASM type)
        const clickedAspectLower = clickedAspectDisplay.toLowerCase() as Aspect;
        
        // Toggle the aspect in excluded list
        if (onAspectClick) {
          onAspectClick(clickedAspectLower);
        }
        
        setHoveredAspect(clickedAspectDisplay);
        setIsAspectLocked(true);
      }
    }
  };

  return (
    <div 
      className="w-full h-full flex items-center justify-center"
      onMouseLeave={() => {
        if (!isAspectLocked) {
          setHoveredAspect(null);
        }
      }}
    >
      <PolarArea data={chartData} options={options} />
    </div>
  );
}
