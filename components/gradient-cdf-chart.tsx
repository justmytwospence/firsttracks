"use client";

import { computeCdf, computeGradient } from "@/lib/geo/geo";
import { formatSlope, gradientToSlopeAngle } from "@/lib/utils";
import { gradientStore, slopeUnitStore } from "@/store";
import type { ActiveElement, ChartEvent, ChartOptions } from "chart.js";
import type { LineString } from "geojson";

// Local type for mappable objects with polyline data
interface Mappable {
  id: string;
  name: string;
  polyline: LineString;
}
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
} from "chart.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Chart } from "react-chartjs-2";

ChartJS.register(
  BarController,
  BarElement,
  CategoryScale,
  LineController,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

const CHART_COLORS = ["#3b82f6", "#64748b", "#f43f5e"];

export default function GradientCdfChart({ mappables }: { mappables: Mappable[] }) {
  const chartRef = useRef<ChartJS<"bar" | "line">>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { setHoveredGradient } = gradientStore();
  const [isGradientLocked, setIsGradientLocked] = useState(false);
  const useDegrees = slopeUnitStore((s) => s.useDegrees);

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

  const {
    gradientMin,
    gradientMax,
    histogramBins,
    histograms,
    maxHistogramValue,
    xAxisRange,
    cdfs,
  } = useMemo(() => {
    const grads = mappables.map((m) => computeGradient(m.polyline.coordinates));
    const all = grads.flat();
    const grMin = Math.min(...all);
    const grMax = Math.max(...all);

    const histogramBinSize = 0.01;
    const bins = Array.from(
      { length: Math.ceil((grMax - grMin) / histogramBinSize) + 1 },
      (_, i) => Number.parseFloat((grMin + i * histogramBinSize).toFixed(3))
    );

    const computeHistogram = (g: number[]): number[] => {
      const counts = new Array(bins.length).fill(0);
      for (const v of g) {
        const idx = Math.min(Math.floor((v - grMin) / histogramBinSize), bins.length - 1);
        if (idx >= 0) counts[idx]++;
      }
      const total = g.length;
      return counts.map((c) => c / total);
    };

    const hists = grads.map(computeHistogram);
    const maxHist = Math.max(...hists.flat());

    const xRange = Array.from(
      { length: Math.round((grMax - grMin) / 0.001) + 1 },
      (_, i) => Number.parseFloat((grMin + i * 0.001).toFixed(3))
    );

    const cdfArrays = grads.map((g) => computeCdf(g, xRange));

    return {
      gradientMin: grMin,
      gradientMax: grMax,
      histogramBins: bins,
      histograms: hists,
      maxHistogramValue: maxHist,
      xAxisRange: xRange,
      cdfs: cdfArrays,
    };
  }, [mappables]);

  // Create datasets: histogram bars first (behind), then CDF lines
  const histogramDatasets = mappables.map((mappable, i) => ({
    type: 'bar' as const,
    label: `${mappable.name || `Route ${i + 1}`} (histogram)`,
    data: histogramBins.map((x, j) => ({ 
      x: useDegrees ? gradientToSlopeAngle(x) : x, 
      y: histograms[i][j] 
    })),
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
    data: xAxisRange.map((x, j) => ({ 
      x: useDegrees ? gradientToSlopeAngle(x) : x, 
      y: cdfs[i][j] 
    })),
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
        min: useDegrees ? gradientToSlopeAngle(gradientMin) : gradientMin,
        max: useDegrees ? gradientToSlopeAngle(gradientMax) : gradientMax,
        ticks: {
          callback: (value) => useDegrees ? `${Number(value).toFixed(0)}°` : `${(Number(value) * 100).toFixed(0)}%`,
        },
        title: {
          display: true,
          text: useDegrees ? "Slope Angle" : "Gradient",
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
        text: useDegrees ? "Slope Angle Distribution" : "Gradient Distribution",
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
          title: (items) => {
            if (items[0]?.parsed?.x == null) return '';
            const xValue = items[0].parsed.x;
            return useDegrees 
              ? `Slope Angle: ${xValue.toFixed(1)}°`
              : `Gradient: ${(xValue * 100).toFixed(1)}%`;
          },
          label: (item) =>
            `${item.dataset.label}: ${((1 - (item.parsed.y ?? 0)) * 100).toFixed(1)}% steeper`,
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
