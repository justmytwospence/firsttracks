"use client";

import { computeCdf, computeGradient } from "@/lib/geo/geo";
import { gradientStore } from "@/store";
import type { ActiveElement, ChartEvent, ChartOptions } from "chart.js";
import type { LineString } from "geojson";

// Local type for mappable objects with polyline data
interface Mappable {
  id: string;
  name: string;
  polyline: LineString;
}
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
} from "chart.js";
import { useEffect, useRef, useState } from "react";
import { Chart } from "react-chartjs-2";

ChartJS.register(
  BarElement,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

const CHART_COLORS = ["#3b82f6", "#64748b", "#f43f5e"];

export default function GradientCdfChart({ mappables }: { mappables: Mappable[] }) {
  const chartRef = useRef<ChartJS>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { setHoveredGradient } = gradientStore();
  const [isGradientLocked, setIsGradientLocked] = useState(false);

  // Resize chart when container size changes (e.g., sidebar toggle)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeChart = () => {
      if (chartRef.current) {
        chartRef.current.resize();
      }
    };

    // Initial resize after mount to ensure correct sizing
    requestAnimationFrame(resizeChart);

    const resizeObserver = new ResizeObserver(() => {
      // Use requestAnimationFrame to batch resize calls
      requestAnimationFrame(resizeChart);
    });
    resizeObserver.observe(container);

    // Find and observe the main flex container that resizes with sidebar
    // Look for an ancestor with flex-1 class or the main content area
    let flexContainer: Element | null = container;
    while (flexContainer && flexContainer !== document.body) {
      const classList = flexContainer.classList;
      if (classList.contains('flex-1') || flexContainer.id === 'main-content') {
        resizeObserver.observe(flexContainer);
        break;
      }
      flexContainer = flexContainer.parentElement;
    }

    // Handle any transition end (captures sidebar width transition)
    const handleTransitionEnd = () => {
      // Multiple delayed resizes to ensure layout has settled
      resizeChart();
      setTimeout(resizeChart, 50);
      setTimeout(resizeChart, 150);
      setTimeout(resizeChart, 350);
    };
    document.addEventListener('transitionend', handleTransitionEnd);

    // Also listen for window resize
    window.addEventListener('resize', resizeChart);

    return () => {
      resizeObserver.disconnect();
      document.removeEventListener('transitionend', handleTransitionEnd);
      window.removeEventListener('resize', resizeChart);
    };
  }, []);

  // Compute gradients and get range
  const gradients = mappables.map((mappable) => {
    return computeGradient(mappable.polyline.coordinates);
  });

  const allGradients = gradients.flat();
  const gradientMin = Math.min(...allGradients);
  const gradientMax = Math.max(...allGradients);
  
  // Use coarser bins for histogram (1% increments instead of 0.1%)
  const histogramBinSize = 0.01;
  const histogramBins = Array.from(
    { length: Math.ceil((gradientMax - gradientMin) / histogramBinSize) + 1 },
    (_, i) => Number.parseFloat((gradientMin + i * histogramBinSize).toFixed(3))
  );
  
  // Compute histogram counts for each bin
  const computeHistogram = (grads: number[], bins: number[]): number[] => {
    const counts = new Array(bins.length).fill(0);
    for (const g of grads) {
      const binIndex = Math.min(
        Math.floor((g - gradientMin) / histogramBinSize),
        bins.length - 1
      );
      if (binIndex >= 0) counts[binIndex]++;
    }
    // Normalize to density (proportion)
    const total = grads.length;
    return counts.map(c => c / total);
  };
  
  const histograms = gradients.map(g => computeHistogram(g, histogramBins));
  const maxHistogramValue = Math.max(...histograms.flat());
  
  // Fine-grained x-axis for CDF
  const xAxisRange = Array.from(
    { length: Math.round((gradientMax - gradientMin) / 0.001) + 1 },
    (_, i) => Number.parseFloat((gradientMin + i * 0.001).toFixed(3))
  );

  // Compute CDFs
  const cdfs = gradients.map((g) => computeCdf(g, xAxisRange));

  // Create datasets: histogram bars first (behind), then CDF lines
  const histogramDatasets = mappables.map((mappable, i) => ({
    type: 'bar' as const,
    label: `${mappable.name || `Route ${i + 1}`} (histogram)`,
    data: histogramBins.map((x, j) => ({ x, y: histograms[i][j] })),
    backgroundColor: `${CHART_COLORS[i % CHART_COLORS.length]}33`, // 20% opacity
    borderColor: 'transparent',
    borderWidth: 0,
    barPercentage: 1.0,
    categoryPercentage: 1.0,
    yAxisID: 'histogram',
    order: 2, // Render behind CDF lines
  }));

  const cdfDatasets = mappables.map((mappable, i) => ({
    type: 'line' as const,
    label: mappable.name || `Route ${i + 1}`,
    data: xAxisRange.map((x, j) => ({ x, y: cdfs[i][j] })),
    borderColor: CHART_COLORS[i % CHART_COLORS.length],
    backgroundColor: "transparent",
    borderWidth: 2,
    tension: 0.1,
    fill: false,
    pointRadius: 0,
    yAxisID: 'y',
    order: 1, // Render in front
  }));

  const initialData = {
    datasets: [...histogramDatasets, ...cdfDatasets],
  };

  const initialOptions: ChartOptions<"bar" | "line"> = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        type: "linear",
        min: gradientMin,
        max: gradientMax,
        ticks: {
          callback: (value) => `${(Number(value) * 100).toFixed(0)}%`,
        },
        title: {
          display: true,
          text: "Gradient",
          font: {
            weight: 'bold',
          },
        },
      },
      y: {
        type: "linear",
        position: "left",
        min: 0,
        max: 1,
        ticks: {
          callback: (value) => `${(Number(value) * 100).toFixed(0)}%`,
        },
        title: {
          display: true,
          text: "CDF",
          font: {
            weight: 'bold',
          },
        },
      },
      histogram: {
        type: "linear",
        position: "right",
        min: 0,
        max: Math.ceil(maxHistogramValue * 100) / 100 + 0.01, // Round up with padding
        grid: {
          drawOnChartArea: false,
        },
        ticks: {
          callback: (value) => `${(Number(value) * 100).toFixed(0)}%`,
        },
        title: {
          display: true,
          text: "Density",
          font: {
            weight: 'bold',
          },
        },
      },
    },
    plugins: {
      title: {
        display: true,
        text: "Gradient Distribution",
      },
      legend: {
        display: mappables.length > 1,
        position: "top",
        labels: {
          filter: (item) => !item.text.includes('(histogram)'),
        },
      },
      tooltip: {
        mode: "index" as const,
        filter: (item) => !item.dataset.label?.includes('(histogram)'),
        callbacks: {
          title: (items) =>
            `Gradient: ${(items[0].parsed.x * 100).toFixed(1)}%`,
          label: (item) =>
            `${item.dataset.label}: ${(item.parsed.y * 100).toFixed(1)}%`,
        },
      },
    },
    interaction: {
      mode: "index" as const,
      intersect: false,
    },
    onHover: (event: ChartEvent, elements: ActiveElement[], chart: ChartJS) => {
      if (!event?.native || !chart?.chartArea) {
        if (!isGradientLocked) setHoveredGradient(null);
        return;
      }

      if (isGradientLocked) return;

      const rect = (
        event.native.target as HTMLCanvasElement
      ).getBoundingClientRect();
      const x = (event.native as MouseEvent).clientX - rect.left;
      const xAxis = chart.scales.x;

      if (x >= xAxis.left && x <= xAxis.right) {
        const gradientValue = xAxis.getValueForPixel(x);
        if (gradientValue === null || gradientValue === undefined) {
          setHoveredGradient(null);
          return;
        }
        // CDF mode: highlight all points >= this gradient
        setHoveredGradient(gradientValue, 'cdf');
      } else {
        setHoveredGradient(null);
      }
    },
    onClick: (event: ChartEvent, elements: ActiveElement[], chart: ChartJS) => {
      if (!event?.native || !chart?.chartArea) return;

      const rect = (
        event.native.target as HTMLCanvasElement
      ).getBoundingClientRect();
      const x = (event.native as MouseEvent).clientX - rect.left;
      const xAxis = chart.scales.x;

      if (x >= xAxis.left && x <= xAxis.right) {
        const gradientValue = xAxis.getValueForPixel(x);
        if (gradientValue === null || gradientValue === undefined) return;
        
        setHoveredGradient(gradientValue, 'cdf');
        setIsGradientLocked(true);
      }
    },
  };

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ position: 'relative' }}
      onMouseLeave={() => {
        setIsGradientLocked(false);
      }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <Chart type="bar" ref={chartRef} data={initialData} options={initialOptions} />
      </div>
    </div>
  );
}
