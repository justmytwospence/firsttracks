import HeartRateChart from "@/components/heart-rate-chart";
import PaceChart from "@/components/pace-chart";
import { Card, CardContent } from "@/components/ui/card";

// Mock data for testing the charts
const mockTimeData = Array.from({ length: 60 }, (_, i) => i * 60); // 60 minutes, every minute
const mockVelocityData = Array.from({ length: 60 }, (_, i) => 
  3 + Math.sin(i * 0.1) * 0.5 + Math.random() * 0.2 // Base pace around 3 m/s with variation
);
const mockHeartRateData = Array.from({ length: 60 }, (_, i) => 
  150 + Math.sin(i * 0.2) * 20 + Math.random() * 10 // Base HR around 150 with variation
);

export default function ChartsTestPage() {
  return (
    <div className="container mx-auto p-4 space-y-6">
      <h1 className="text-3xl font-bold">Activity Charts Test</h1>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="h-[400px]">
          <CardContent className="h-full">
            <div className="h-full">
              <PaceChart 
                velocityData={mockVelocityData}
                timeData={mockTimeData}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="h-[400px]">
          <CardContent className="h-full">
            <div className="h-full">
              <HeartRateChart 
                heartRateData={mockHeartRateData}
                timeData={mockTimeData}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}