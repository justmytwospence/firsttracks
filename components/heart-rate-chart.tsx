"use client";

import type { ActivityStreamData } from "@/lib/db/activity-streams";
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
  streams: ActivityStreamData[];
}

export default function HeartRateChart({ streams }: HeartRateChartProps) {
  // Filter streams with heart rate data
  const hrData = streams
    .filter(stream => stream.heartrate && stream.heartrate > 0)
    .map(stream => ({
      time: stream.time,
      heartrate: stream.heartrate!,
      distance: stream.distance ? stream.distance * 0.000621371 : 0, // meters to miles
    }));

  if (hrData.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No heart rate data available
      </div>
    );
  }

  const chartData: ChartData<'line'> = {
    labels: hrData.map(point => 
      point.distance.toFixed(1) + 'mi'
    ),
    datasets: [
      {
        label: 'Heart Rate (bpm)',
        data: hrData.map(point => point.heartrate),
        borderColor: 'rgb(239, 68, 68)',
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
      },
    ],
  };

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      title: {
        display: true,
        text: 'Heart Rate Over Distance',
        font: {
          size: 16,
          weight: 'bold',
        },
      },
      tooltip: {
        callbacks: {
          label: (context) => {
            return `HR: ${context.parsed.y} bpm`;
          },
        },
      },
    },
    scales: {
      x: {
        title: {
          display: true,
          text: 'Distance (miles)',
        },
        ticks: {
          maxTicksLimit: 10,
        },
      },
      y: {
        title: {
          display: true,
          text: 'Heart Rate (bpm)',
        },
        min: Math.max(0, Math.min(...hrData.map(d => d.heartrate)) - 10),
        max: Math.max(...hrData.map(d => d.heartrate)) + 10,
      },
    },
  };

  return (
    <div className="h-64 w-full">
      <Line data={chartData} options={options} />
    </div>
  );
}