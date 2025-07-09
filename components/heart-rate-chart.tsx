"use client";

import type { HoverIndexStore } from "@/store";
import { hoverIndexStore as defaultHoverIndexStore } from "@/store";
import type { ChartData, ChartOptions } from "chart.js";
import {
  CategoryScale,
  Chart as ChartJS,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
} from "chart.js";
import { useEffect, useRef } from "react";
import { Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip
);

interface HeartRateChartProps {
  heartRateData: number[]; // heart rate in bpm
  timeData: number[]; // time in seconds
  hoverIndexStore?: HoverIndexStore;
}

export default function HeartRateChart({
  heartRateData,
  timeData,
  hoverIndexStore = defaultHoverIndexStore,
}: HeartRateChartProps) {
  const chartRef = useRef<ChartJS<"line">>(null);
  const { setHoverIndex } = hoverIndexStore();

  // Convert time from seconds to minutes for display
  const timeInMinutes = timeData.map((time) => time / 60);

  const hrMin = Math.min(...heartRateData.filter(hr => hr > 0));
  const hrMax = Math.max(...heartRateData);
  const hrPadding = (hrMax - hrMin) * 0.1;

  const initialData: ChartData<"line"> = {
    labels: timeInMinutes,
    datasets: [
      {
        label: "Heart Rate (bpm)",
        data: heartRateData,
        borderColor: "rgb(239, 68, 68)", // red
        backgroundColor: "rgba(239, 68, 68, 0.1)",
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointBackgroundColor: "rgb(239, 68, 68)",
        tension: 0.1,
        fill: true,
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
        max: Math.max(...timeInMinutes),
        title: {
          display: true,
          text: "Time (minutes)",
        },
        ticks: {
          callback: (value) => Number(value).toFixed(0),
        },
      },
      y: {
        type: "linear" as const,
        min: Math.max(0, hrMin - hrPadding),
        max: hrMax + hrPadding,
        title: {
          display: true,
          text: "Heart Rate (bpm)",
        },
        ticks: {
          callback: (value) => Math.round(Number(value)).toString(),
        },
      },
    },
    plugins: {
      title: {
        display: true,
        text: "Heart Rate Over Time",
      },
      legend: {
        display: false,
      },
      tooltip: {
        callbacks: {
          title: (context) => {
            const timeInMins = Number.parseFloat(context[0]?.label || "0");
            const hours = Math.floor(timeInMins / 60);
            const minutes = Math.floor(timeInMins % 60);
            const seconds = Math.round((timeInMins % 1) * 60);
            if (hours > 0) {
              return `Time: ${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            }
            return `Time: ${minutes}:${seconds.toString().padStart(2, '0')}`;
          },
          label: (context) => {
            const hr = Math.round(context.parsed.y);
            return `Heart Rate: ${hr} bpm`;
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

  // Handle hover index updates
  useEffect(() => {
    const unsubHoverIndex = hoverIndexStore.subscribe((state) => {
      if (!chartRef.current) return;
      const chart = chartRef.current as ChartJS<"line">;

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

  return <Line ref={chartRef} data={initialData} options={initialOptions} />;
}