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

interface PaceChartProps {
  streams: ActivityStreamData[];
}

export default function PaceChart({ streams }: PaceChartProps) {
  // Filter streams with velocity data and convert to pace
  const paceData = streams
    .filter(stream => stream.velocitySmooth && stream.velocitySmooth > 0)
    .map(stream => {
      // Convert velocity (m/s) to pace (min/mile)
      const mphSpeed = (stream.velocitySmooth! * 2.237); // m/s to mph
      const paceMinPerMile = 60 / mphSpeed; // Convert to minutes per mile
      return {
        time: stream.time,
        pace: paceMinPerMile,
        distance: stream.distance ? stream.distance * 0.000621371 : 0, // meters to miles
      };
    });

  if (paceData.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No pace data available
      </div>
    );
  }

  const chartData: ChartData<'line'> = {
    labels: paceData.map(point => 
      point.distance.toFixed(1) + 'mi'
    ),
    datasets: [
      {
        label: 'Pace (min/mile)',
        data: paceData.map(point => point.pace),
        borderColor: 'rgb(59, 130, 246)',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
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
        text: 'Pace Over Distance',
        font: {
          size: 16,
          weight: 'bold',
        },
      },
      tooltip: {
        callbacks: {
          label: (context) => {
            const pace = context.parsed.y;
            const minutes = Math.floor(pace);
            const seconds = Math.floor((pace - minutes) * 60);
            return `Pace: ${minutes}:${seconds.toString().padStart(2, '0')}/mile`;
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
          text: 'Pace (min/mile)',
        },
        ticks: {
          callback: function(value) {
            const pace = Number(value);
            const minutes = Math.floor(pace);
            const seconds = Math.floor((pace - minutes) * 60);
            return `${minutes}:${seconds.toString().padStart(2, '0')}`;
          },
        },
      },
    },
  };

  return (
    <div className="h-64 w-full">
      <Line data={chartData} options={options} />
    </div>
  );
}