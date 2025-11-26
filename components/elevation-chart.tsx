"use client";

import { computeDistanceMiles, computeGradient } from "@/lib/geo/geo";
import type { HoverIndexStore } from "@/store";
import {
  hoverIndexStore as defaultHoverIndexStore,
  gradientStore,
} from "@/store";
import type { ChartData, ChartOptions } from "chart.js";
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
} from "chart.js";
import type { LineString } from "geojson";
import { useEffect, useRef } from "react";
import { Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler
);

export default function ElevationChart({
  polyline,
  hoverIndexStore = defaultHoverIndexStore,
}: {
  polyline: LineString;
  hoverIndexStore?: HoverIndexStore;
}) {
  const chartRef = useRef<ChartJS<"line">>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { setHoverIndex } = hoverIndexStore();
  const { hoveredGradient } = gradientStore();

  // Resize chart when container size changes (e.g., sidebar toggle)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current) {
        chartRef.current.resize();
      }
    });

    resizeObserver.observe(container);

    // Also handle transition end events
    const handleTransitionEnd = () => {
      if (chartRef.current) {
        chartRef.current.resize();
      }
    };
    document.addEventListener('transitionend', handleTransitionEnd);

    return () => {
      resizeObserver.disconnect();
      document.removeEventListener('transitionend', handleTransitionEnd);
    };
  }, []);

  // Compute values immediately
  const computedDistances = computeDistanceMiles(polyline.coordinates);
  const computedGradients = computeGradient(polyline.coordinates);
  const elevation = polyline.coordinates.map((point) => point[2] * 3.28084);
  const elevationMin = Math.min(...elevation);
  const elevationMax = Math.max(...elevation);
  const elevationPadding = (elevationMax - elevationMin) * 0.1;
  const gradientMin = Math.max(Math.min(...computedGradients), -0.3);
  const gradientMax = Math.min(Math.max(...computedGradients), 0.3);

  // Initial chart configuration
  const initialData: ChartData<"line"> = {
    labels: computedDistances,
    datasets: [
      {
        label: "Elevation (ft)",
        data: elevation,
        borderColor: "black",
        backgroundColor: "transparent",
        yAxisID: "elevation",
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointBackgroundColor: "black",
        tension: 0.1,
      },
      {
        label: "Gradient (%)",
        data: computedGradients,
        borderColor: "transparent",
        yAxisID: "gradient",
        pointRadius: 0,
        fill: true,
        borderWidth: 0,
        segment: {
          backgroundColor: (ctx) => {
            const gradientValue = ctx.p0.parsed.y;
            return hoveredGradient && gradientValue >= hoveredGradient
              ? "rgba(255, 0, 0, 0.5)"
              : "rgba(128, 128, 128, 0.5)";
          },
        },
      },
    ],
  };

  const initialOptions: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 0,
    },
    scales: {
      x: {
        type: "linear" as const,
        min: 0,
        max: Math.max(...computedDistances),
        ticks: {
          stepSize: 1,
          callback: (value) => Number(value).toFixed(1),
        },
        title: {
          display: true,
          text: "Miles",
        },
      },
      elevation: {
        display: true,
        min: Math.floor(elevationMin - elevationPadding),
        max: Math.ceil(elevationMax + elevationPadding),
        position: "left" as const,
        type: "linear" as const,
        title: {
          display: true,
          text: "Elevation (ft)",
        },
        ticks: {
          stepSize: 100,
          callback: (value) => Math.round(Number(value)).toLocaleString(),
        },
        grid: {
          drawOnChartArea: false,
        },
      },
      gradient: {
        type: "linear" as const,
        display: true,
        position: "right" as const,
        min: gradientMin,
        max: gradientMax,
        title: {
          display: true,
          text: "Gradient (%)",
        },
        ticks: {
          stepSize: 0.01,
          callback: (value) => `${(Number(value) * 100).toFixed(0)}%`,
        },
        grid: {
          drawOnChartArea: true,
          drawTicks: true,
        },
      },
    },
    plugins: {
      title: {
        display: true,
        text: "Elevation and Gradient Profile",
      },
      legend: {
        display: false,
      },
      tooltip: {
        callbacks: {
          title: (context) => {
            const label = context[0]?.label;
            return `Distance: ${Number.parseFloat(label).toFixed(0)} miles`;
          },
          label: (context) => {
            const label = context.dataset.label || "";
            if (label === "Elevation (ft)") {
              return `Elevation: ${Math.round(
                context.parsed.y
              ).toLocaleString()} ft`;
            }if (label === "Gradient (%)") {
              return `Gradient: ${(context.parsed.y * 100).toFixed(1)}%`;
            }
            return label;
          },
        },
      },
    },
    interaction: {
      mode: "index",
      intersect: false,
    },
    onHover: (event, elements, chart) => {
      if (!event?.native || !chart?.chartArea) {
        setHoverIndex(-1);
        return;
      }

      const elementsAtEvent = chart.getElementsAtEventForMode(
        event.native,
        "index",
        { intersect: false },
        false
      );

      if (elementsAtEvent.length > 0) {
        setHoverIndex(elementsAtEvent[0].index);
      } else {
        setHoverIndex(-1);
      }
    },
  };

  // hoverIndex
  useEffect(() => {
    interface HoverIndexState {
      hoverIndex: number;
    }

    interface ChartRef {
      current: ChartJS<"line"> | null;
    }

    const unsubHoverIndex = hoverIndexStore.subscribe((state) => {
      if (!chartRef.current) return;
      const chart = chartRef.current as ChartJS<"line">;

      console.log(state)
      if (state?.hoverIndex >= 0) {
        chart.setActiveElements([
          {
            datasetIndex: 0,
            index: state.hoverIndex,
          },
        ]);
        if (chart.tooltip) {
          chart.tooltip.setActiveElements(
            [
              {
                datasetIndex: 0,
                index: state.hoverIndex,
              },
            ],
            { x: 0, y: 0 } 
          );
        }
      } else {
        chart.setActiveElements([]);
        if (chart.tooltip) {
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
        }
      }
    });
    return unsubHoverIndex;
  }, [hoverIndexStore]);

  return (
    <div ref={containerRef} className="h-full w-full">
      <Line ref={chartRef} data={initialData} options={initialOptions} />
    </div>
  );
}