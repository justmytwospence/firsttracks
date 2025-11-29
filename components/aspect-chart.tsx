import type { Aspect } from "@/components/find-path-button";
import { aspectStore } from '@/store';
import { type ActiveElement, ArcElement, type ChartEvent, Chart as ChartJS, Legend, RadialLinearScale, Tooltip } from 'chart.js';
import type { FeatureCollection } from 'geojson';
import { useState } from 'react';
import { useMemo } from 'react';
import { PolarArea } from 'react-chartjs-2';

ChartJS.register(RadialLinearScale, ArcElement, Tooltip, Legend);

const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
const ASPECT_MAP: Record<string, Aspect> = {
  N: 'north',
  NE: 'northeast',
  E: 'east',
  SE: 'southeast',
  S: 'south',
  SW: 'southwest',
  W: 'west',
  NW: 'northwest'
};
const DIRECTION_TO_INDEX: Record<Aspect, number> = {
  north: 0,
  northeast: 1,
  east: 2,
  southeast: 3,
  south: 4,
  southwest: 5,
  west: 6,
  northwest: 7
};

const NEUTRAL_COLOR = 'rgba(128, 128, 128, 0.5)';
const HIGHLIGHT_COLOR = 'rgba(255, 165, 0, 0.7)';
const HIGHLIGHT_BORDER = 'rgba(255, 165, 0, 1)';

export interface AspectChartProps {
  aspectPoints: FeatureCollection;
  excludedAspects?: Aspect[];
  onAspectClick?: (aspect: Aspect) => void;
}

export function AspectChart({ aspectPoints, excludedAspects, onAspectClick }: AspectChartProps) {
  const { setHoveredAspect, hoveredAspect } = aspectStore();
  const [isAspectLocked, setIsAspectLocked] = useState(false);
  const aspects = aspectPoints.features.map(feature => feature.properties?.aspect);
  
  const chartData = useMemo(() => {
    const aspectCounts = aspects.reduce((acc, aspect) => {
      if (aspect) {
        acc[aspect] = (acc[aspect] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);

    const counts = DIRECTIONS.map(dir => aspectCounts[ASPECT_MAP[dir]] || 0);

    // Compute colors based on current hoveredAspect
    const backgrounds = DIRECTIONS.map((_, i) => {
      if (hoveredAspect && DIRECTION_TO_INDEX[hoveredAspect] === i) {
        return HIGHLIGHT_COLOR;
      }
      return NEUTRAL_COLOR;
    });
    const borders = DIRECTIONS.map((_, i) => {
      if (hoveredAspect && DIRECTION_TO_INDEX[hoveredAspect] === i) {
        return HIGHLIGHT_BORDER;
      }
      return 'rgba(128, 128, 128, 0.8)';
    });
    const borderWidths = DIRECTIONS.map((_, i) => {
      if (hoveredAspect && DIRECTION_TO_INDEX[hoveredAspect] === i) {
        return 2;
      }
      return 1;
    });

    return {
      labels: [...DIRECTIONS],
      datasets: [{
        data: counts,
        backgroundColor: backgrounds,
        borderColor: borders,
        borderWidth: borderWidths
      }]
    };
  }, [aspects, hoveredAspect]);

  const options = {
    responsive: true,
    scales: {
      r: {
        type: 'radialLinear' as const,
        startAngle: -22.5,
        ticks: {
          display: true,
          callback: function(this: { chart: ChartJS }, tickValue: number | string) {
            const total = this.chart.data.datasets[0].data.reduce((a: number, b) => a + (b as number), 0);
            return `${Math.round((Number(tickValue) / total) * 100)}%`;
          },
          backdropColor: 'transparent'  // Makes the background transparent
        },
        beginAtZero: true
      }
    },
    plugins: {
      tooltip: {
        displayColors: false,
        callbacks: {
          title: (context) => {
            const directionNames: Record<string, string> = {
              'N': 'North',
              'NE': 'Northeast',
              'E': 'East',
              'SE': 'Southeast',
              'S': 'South',
              'SW': 'Southwest',
              'W': 'West',
              'NW': 'Northwest'
            };
            const label = context[0]?.label || '';
            return directionNames[label] || label;
          },
          label: (context) => {
            const total = context.chart.data.datasets[0].data.reduce((a: number, b) => a + (b as number), 0);
            const value = context.raw as number;
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
        const hoveredAspect = ASPECT_MAP[direction];
        setHoveredAspect(hoveredAspect);
      } else {
        setHoveredAspect(null);
      }
    },
    onClick: (_event: ChartEvent, elements: ActiveElement[]) => {
      if (elements?.[0]) {
        const index = elements[0].index;
        const direction = chartData.labels[index];
        const clickedAspect = ASPECT_MAP[direction];
        
        // Toggle the aspect in excluded list
        if (onAspectClick) {
          onAspectClick(clickedAspect);
        }
        
        setHoveredAspect(clickedAspect);
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
